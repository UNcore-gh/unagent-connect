import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const LIMIT = 2 * 1024 * 1024;
// Frozen Hub public tools only. No prefix wildcards, admin RPC, arbitrary MCP
// namespace, or permission-changing native tool can enter this allowlist.
export const hubToolNames = Object.freeze([
  'participants_list', 'threads_create', 'threads_list', 'messages_send', 'messages_list', 'messages_ack',
  'runs_submit', 'runs_list', 'runs_get', 'runs_wait', 'inbox_list', 'runs_claim', 'runs_heartbeat',
  'runs_complete', 'runs_fail', 'runs_cancel', 'runs_rework', 'questions_ask', 'questions_answer', 'events_list',
].map(name => `connect_${name}`));
const claudeHubTools = new Set(hubToolNames.map(name => `mcp__unagent-connect__${name}`));
export const isScopedHubTool = name => claudeHubTools.has(name);
export const capabilities = Object.freeze({ manualMessaging: true, automaticExecution: true,
  sessionResume: true, cancellation: true, permissions: true, contextRead: false, artifacts: true });
export const failure = (code, message) => Object.assign(new Error(message), { code });
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  // Native events can fail before execute reaches its await.
  promise.catch(() => {});
  return { promise, resolve, reject };
};
export function text(value, max = 8192) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}
export function id(value) {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\x00-\x20]/u.test(value)) {
    throw failure('NATIVE_PROTOCOL', 'Invalid native identifier');
  }
  return value;
}
export function bounded(value, max = LIMIT) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > max) throw failure('DATA_LIMIT', 'Native data exceeds size limit');
  return encoded;
}
export function executable(value, fallback) {
  value ??= fallback;
  if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\x00\r\n]/u.test(value)) {
    throw failure('INVALID_CONFIG', 'Expected a native executable path, not a shell command');
  }
  return value;
}
export function mcpEntry(config) {
  if (config == null) return undefined;
  const command = executable(config.command);
  const args = config.args ?? [];
  const env = config.env ?? {};
  if (!Array.isArray(args) || args.length > 128 || args.some(x => typeof x !== 'string' || x.includes('\0')) ||
      !env || typeof env !== 'object' || Array.isArray(env) ||
      Object.entries(env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(k) || typeof v !== 'string' || v.includes('\0'))) {
    throw failure('INVALID_CONFIG', 'Invalid scoped MCP stdio entry');
  }
  bounded({ command, args, env }, 128 * 1024);
  return { command, args: [...args], env: { ...env } };
}
export async function workspace(ctx) {
  if (!isAbsolute(ctx.run.workspace ?? '') || !isAbsolute(ctx.participant.workspace ?? '')) {
    throw failure('WORKSPACE_MISMATCH', 'Adapter requires absolute project directories');
  }
  const [a, b] = await Promise.all([realpath(ctx.run.workspace), realpath(ctx.participant.workspace)]);
  if (a !== b) throw failure('WORKSPACE_MISMATCH', 'Run and participant project differ');
  if (typeof ctx.run.content !== 'string' || Buffer.byteLength(ctx.run.content) > LIMIT) {
    throw failure('DATA_LIMIT', 'Prompt is missing or exceeds size limit');
  }
  return a;
}
export const attemptKey = ctx => `${ctx.run.id}:${ctx.run.attemptId ?? ctx.run.round ?? 0}`;
export const projectKey = (ctx, cwd) => `${ctx.participant.id}:${cwd}`;
export function binding(adapter, ctx, cwd, nativeSessionId, extra = {}) {
  return { adapter, participantId: ctx.participant.id, workspace: cwd,
    dedicated: true, nativeSessionId, ...extra };
}
export function owned(value, adapter, ctx, cwd, sessionId) {
  return value?.adapter === adapter && value.participantId === ctx.participant.id &&
    value.workspace === cwd && value.nativeSessionId === sessionId && value.dedicated === true;
}
const leases = new Set();
export function reserve(key) {
  if (leases.has(key)) throw failure('SESSION_BUSY', 'Native session or participant project is already running');
  leases.add(key);
  return () => leases.delete(key);
}
export function abortable(promise, signal) {
  if (signal?.aborted) return Promise.reject(failure('CANCELLED', 'Native question cancelled'));
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(failure('CANCELLED', 'Native question cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
  });
}
// Hub owns one open question per run. Native engines may ask concurrently;
// queue their callbacks while leaving RPC response/notification reading live.
export function questionQueue(ctx, signal) {
  let tail = Promise.resolve(), pending = 0;
  return async (question, requestSignal) => {
    if (pending >= 16) throw failure('DATA_LIMIT', 'Too many queued native questions');
    pending++;
    const previous = tail, next = deferred(); tail = next.promise;
    const stop = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
    try {
      await abortable(previous, stop);
      if (stop.aborted) throw failure('CANCELLED', 'Native question cancelled');
      const reply = await abortable(Promise.resolve().then(() => {
        if (stop.aborted) throw failure('CANCELLED', 'Native question cancelled');
        return ctx.ask(question);
      }), stop);
      if (stop.aborted) throw failure('CANCELLED', 'Native question cancelled');
      return reply;
    } finally { pending--; next.resolve(); }
  };
}
export function deadline(ctx, maxMs = 10 * 60_000) {
  const end = ctx.run.deadlineAt == null ? Date.now() + maxMs :
    typeof ctx.run.deadlineAt === 'number' ? ctx.run.deadlineAt : Date.parse(ctx.run.deadlineAt);
  if (!Number.isFinite(end) || end <= Date.now()) throw failure('DEADLINE_EXCEEDED', 'Run deadline has expired');
  return Math.min(maxMs, end - Date.now());
}
export async function waitStopped(state, timeoutMs) {
  if (state.terminal) return { stopped: true };
  let timer;
  try {
    return await Promise.race([state.finished.promise.then(() => ({ stopped: Boolean(state.terminal) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ stopped: false }), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

// Codex stdio is newline-delimited JSON-RPC (no Content-Length headers).
// No stderr or raw wire bodies are exposed: they can contain credentials.
export class NativeRpc extends EventEmitter {
  constructor(command, args, { cwd, env, spawnProcess = spawn, timeoutMs = 30_000, maxFrameBytes = LIMIT } = {}) {
    super();
    this.pending = new Map(); this.nextId = 0; this.buffer = ''; this.bytes = 0;
    this.timeoutMs = timeoutMs; this.maxFrameBytes = maxFrameBytes;
    this.decoder = new StringDecoder('utf8');
    this.child = spawnProcess(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stderr?.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(failure('NATIVE_DISCONNECTED', 'Native stdin closed')));
    this.child.on('error', () => this.fail(failure('NATIVE_UNAVAILABLE', 'Cannot start native executable')));
    this.child.on('close', () => this.fail(failure('NATIVE_DISCONNECTED', 'Native process closed')));
  }
  receive(chunk) {
    if (this.closed) return;
    // Reject oversized chunks before decoding/allocating another copy.
    if (chunk.length > this.maxFrameBytes * 2) return this.fail(failure('DATA_LIMIT', 'Oversized native chunk'));
    const data = this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let offset = 0;
    for (;;) {
      const end = data.indexOf('\n', offset);
      const part = data.slice(offset, end < 0 ? undefined : end);
      this.bytes += Buffer.byteLength(part);
      if (this.bytes > this.maxFrameBytes) return this.fail(failure('DATA_LIMIT', 'Oversized native frame'));
      this.buffer += part;
      if (end < 0) break;
      const line = this.buffer; this.buffer = ''; this.bytes = 0; offset = end + 1;
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error();
        if (msg.id != null && !((typeof msg.id === 'string' && msg.id.length <= 256) ||
          (typeof msg.id === 'number' && Number.isSafeInteger(msg.id)))) throw new Error();
      } catch { return this.fail(failure('NATIVE_PROTOCOL', 'Malformed native JSON-RPC')); }
      if (typeof msg.method === 'string') {
        this.emit(msg.id == null ? 'notification' : 'request', msg);
      } else if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(failure('NATIVE_REJECTED', 'Native RPC request rejected'),
          { nativeRejected: true, nativeCode: msg.error.code, rpcMethod: p.method }));
        else if (Object.hasOwn(msg, 'result')) p.resolve(msg.result);
        else p.reject(failure('NATIVE_PROTOCOL', 'Native response has no result'));
      }
      if (this.closed) break;
    }
  }
  send(message) {
    if (this.closed) throw failure('NATIVE_DISCONNECTED', 'Native transport closed');
    const line = bounded(message, this.maxFrameBytes) + '\n';
    if (this.child.stdin.writableLength > this.maxFrameBytes * 2) throw failure('DATA_LIMIT', 'Native write queue full');
    this.child.stdin.write(line);
  }
  request(method, params = {}) {
    if (this.pending.size >= 64) return Promise.reject(failure('DATA_LIMIT', 'Too many native requests'));
    const n = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(n); reject(failure('RPC_TIMEOUT', `Native ${method} timed out`)); }, this.timeoutMs);
      this.pending.set(n, { resolve, reject, timer, method });
      try { this.send({ id: n, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(n); reject(e); }
    });
  }
  notify(method, params) { this.send({ method, ...(params === undefined ? {} : { params }) }); }
  respond(requestId, result) { this.send({ id: requestId, result }); }
  reject(requestId) { this.send({ id: requestId, error: { code: -32601, message: 'Unsupported or out-of-scope native request' } }); }
  fail(error) {
    if (this.closed) return;
    this.closed = true; this.error = error; this.buffer = '';
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('disconnect', error);
  }
  close() {
    this.fail(failure('NATIVE_DISCONNECTED', 'Adapter transport disposed'));
    this.child.stdin.end();
    // This only cleans up the process we launched; it is never stop evidence.
    this.child.kill('SIGTERM');
    const child = this.child;
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
}

/** Optional explicit final-result envelope; paths are validated by Hub, never trusted here. */
export function nativeResult(value) {
  const raw=Array.isArray(value)?value.join('\n\n'):String(value),candidate=Array.isArray(value)?String(value.at(-1)??''):raw,body=candidate.trim().replace(/^```json\s*\n([\s\S]*?)\n```$/i,'$1')
  let parsed;try{parsed=JSON.parse(body)}catch{return{text:raw}}
  if(!parsed||typeof parsed!=='object'||!Object.hasOwn(parsed,'artifacts'))return{text:raw}
  if(typeof parsed.text!=='string'||!parsed.text.trim()||!Array.isArray(parsed.artifacts)||parsed.artifacts.length>40||parsed.artifacts.some(p=>typeof p!=='string'||p.length>4096))throw failure('INVALID_OUTPUT','Native artifact envelope is invalid')
  return{text:parsed.text,artifacts:parsed.artifacts}
}
