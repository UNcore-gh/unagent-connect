import { spawn } from 'node:child_process';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const capabilities = Object.freeze({ manualMessaging: true, automaticExecution: true,
  sessionResume: true, cancellation: true, permissions: false, contextRead: false, artifacts: true,
  requiresConnector: true, automaticHandoff: false });
export function fault(code, message) { return Object.assign(new Error(message), { code }); }
export const unknown = message => fault('OUTCOME_UNKNOWN', message);
export async function supervise(action) {
  try { return await action(); }
  catch (error) {
    if (['OUTCOME_UNKNOWN', 'NATIVE_FAILED', 'NATIVE_REJECTED'].includes(error.code)) throw error;
    throw unknown('Native supervision could not verify this operation; retain its binding and recover without resubmission');
  }
}
export function required(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw fault('NEEDS_SETUP', `${name} is required`);
  return value;
}
export async function sameWorkspace(actual, expected) {
  if (!actual || !expected || !path.isAbsolute(actual) || !path.isAbsolute(expected)
    || await realpath(actual) !== await realpath(expected)) throw fault('BINDING_MISMATCH', 'Native session project does not match this run');
}
export function configOf(ctx) { return ctx.participant.config ?? {}; }
export function bindingOf(ctx, provider) {
  const b = ctx.run.nativeBinding;
  if (b && (b.provider !== provider || b.workspace !== ctx.run.workspace || b.participantId !== ctx.participant.id))
    throw fault('BINDING_MISMATCH', 'Binding belongs to another provider, participant or project');
  return b;
}
export async function persist(ctx, b) {
  await ctx.saveBinding({ nativeSessionId: b.sessionId, nativeBinding: b });
  return b;
}
export function baseBinding(ctx, provider, fields = {}) {
  return { provider, workspace: ctx.run.workspace, participantId: ctx.participant.id, ...fields };
}
export function warnMcp(ctx) {
  if (ctx.mcpConfig) ctx.emit?.({ type: 'capability', text: '此原生 connector 无法附加本轮 MCP；自动转交不可用。通用 skill 的外部手动接活仍可用。', data: { automaticHandoff: false, manualMessaging: true } });
}
export function check(ctx) {
  if (ctx.signal?.aborted) throw unknown('Supervision aborted; query/cancel the saved native operation before retrying');
  if (ctx.run.deadlineAt && Date.now() >= (typeof ctx.run.deadlineAt === 'number' ? ctx.run.deadlineAt : Date.parse(ctx.run.deadlineAt)))
    throw unknown('Supervision deadline elapsed; native execution may continue. Recover without resubmission');
}
export async function pause(ctx, ms = 300) {
  check(ctx);
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); ctx.signal?.addEventListener('abort', done, { once: true });
  });
  check(ctx);
}
// Cancelling supervision must unblock an ask even when the host's ask promise is still pending.
export function questions() {
  const pending = new Map();
  return {
    abort(ctx) { pending.get(ctx.run.attemptId)?.(); },
    async ask(ctx, question) {
      check(ctx);
      let rejectWait;
      const stopped = new Promise((_, reject) => { rejectWait = () => reject(unknown('Question cancelled; native stop still needs evidence')); });
      pending.set(ctx.run.attemptId, rejectWait);
      ctx.signal?.addEventListener('abort', rejectWait, { once: true });
      try { return await Promise.race([Promise.resolve().then(() => ctx.ask(question)), stopped]); }
      finally { pending.delete(ctx.run.attemptId); ctx.signal?.removeEventListener('abort', rejectWait); }
    },
  };
}
// stdin carries task bodies; no shell interpolation, credential copying or global cwd changes.
export function jsonProcess(command, args, { cwd, input, timeoutMs = 120000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', ended = false;
    const finish = (error, result) => { if (ended) return; ended = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(unknown('Connector helper timed out; do not replay native mutations')); }, timeoutMs);
    for (const [stream, output] of [[child.stdout, true], [child.stderr, false]]) {
      stream.setEncoding('utf8'); stream.on('data', chunk => {
        if (output) stdout += chunk; else stderr += chunk;
        if (stdout.length + stderr.length > 4 * 1024 * 1024) { child.kill('SIGTERM'); finish(unknown('Connector response exceeded limit')); }
      });
    }
    child.on('error', () => finish(fault('NEEDS_SETUP', 'Connector helper could not start')));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const value = JSON.parse(lines.at(-1) ?? stderr.trim().split('\n').at(-1));
        if (code !== 0 || value.error || value.ok === false) {
          // Do not expose raw connector errors: they may contain private native envelopes.
          const nativeCode = typeof value.error?.code === 'string' ? value.error.code : 'CONNECTOR_ERROR';
          finish(fault(nativeCode, `Connector operation failed (${nativeCode}); inspect the native application`));
        } else finish(null, value);
      } catch { finish(unknown('Connector returned no valid receipt; query the saved operation')); }
    });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
export async function gatewayCall(provider, config, operation, params) {
  const dir = required(config.gatewayDir, 'config.gatewayDir');
  if (!path.isAbsolute(dir)) throw fault('NEEDS_SETUP', 'gatewayDir must be absolute');
  return jsonProcess(process.execPath, [fileURLToPath(import.meta.url), provider, dir, operation], { cwd: dir, input: params });
}
export async function bridgeCall(config, method, params, idem) {
  const dir = required(config.bridgeDir, 'config.bridgeDir (0.1.1 legacy or 0.2.x connector)');
  if (!path.isAbsolute(dir)) throw fault('NEEDS_SETUP', 'bridgeDir must be absolute');
  const version = (await readFile(path.join(dir, 'VERSION'), 'utf8')).trim();
  if (version !== '0.1.1' && !/^0\.2\.\d+$/.test(version)) throw fault('INCOMPATIBLE', 'UNagent requires bridge CLI 0.1.1 or 0.2.x');
  const result = await jsonProcess(process.execPath, [path.join(dir, 'scripts/unagent-connect.mjs'), 'call', method,
    '--instance', required(config.instanceId, 'config.instanceId'), '--client', required(config.clientProfile, 'config.clientProfile'),
    '--idem', required(idem, 'idempotency key'), '--params-file', '-', '--timeout-ms', '10000'], { cwd: dir, input: params, timeoutMs: 20000 });
  if (result.status !== 'completed' || !Object.hasOwn(result, 'result')) throw unknown('Bridge has no completed business receipt; query, never send again');
  return result.result;
}

async function helper(provider, dir, operation, params) {
  const moduleAt = relative => import(pathToFileURL(path.join(dir, relative)).href);
  if (provider === 'workbuddy' && ['native_session', 'native_create', 'native_snapshot', 'native_cancel'].includes(operation)) {
    // Preload only inside the ORIGINAL launcher. Its own shell loads private configuration;
    // this process never reads/copies .env, credentials, or the native task database.
    return jsonProcess(path.join(dir, 'bin/workbuddy-gateway'), [], { cwd: dir,
      env: { ...process.env, UNAGENT_CONNECT_GATEWAY_PRELOAD: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${import.meta.url}` }, input: { operation, params } });
  }
  if (provider === 'harness') {
    const { DeepSeekClient } = await moduleAt('dist/deepseek-client.js');
    const client = new DeepSeekClient();
    const allowed = new Set(['health', 'session', 'create', 'prompt', 'events', 'cancel']);
    if (!allowed.has(operation)) throw fault('INVALID_OPERATION', 'Unsupported Harness operation');
    // Registry credentials remain wholly inside the old runtime client.
    return operation === 'health' ? client.health(params.hostId) : client[operation](params);
  }
  if (provider !== 'workbuddy' || !/^workbuddy_(health|list_workspaces|ensure_workspace|send_task|get_task|respond_task|cancel_task)$/.test(operation))
    throw fault('INVALID_OPERATION', 'Unsupported WorkBuddy operation');
  const { Client } = await moduleAt('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StdioClientTransport } = await moduleAt('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const client = new Client({ name: 'unagent-connect-native', version: '0.2.0' });
  const transport = new StdioClientTransport({ command: path.join(dir, 'bin/workbuddy-gateway'), cwd: dir,
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')), stderr: 'ignore' });
  try {
    // This launcher, owned by the original gateway, loads its private config itself.
    await client.connect(transport);
    const result = await client.callTool({ name: operation, arguments: params }, undefined, { timeout: 100000 });
    const block = result.content?.find(b => b.type === 'text');
    const value = JSON.parse(block?.text ?? '{}');
    if (result.isError || value.ok === false) throw fault('CONNECTOR_ERROR', 'Native MCP operation failed');
    return value;
  } finally { await client.close(); }
}
if (process.env.UNAGENT_CONNECT_GATEWAY_PRELOAD === '1') {
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 1048576) throw new Error('Input too large'); }
    const { operation, params } = JSON.parse(input);
    const root = process.cwd(), at = rel => import(pathToFileURL(path.join(root, 'dist', rel)).href);
    const { loadConfig } = await at('config.js');
    const config = loadConfig();
    let value;
    if (operation === 'native_snapshot' || operation === 'native_cancel') {
      const { WorkBuddyClient } = await at('workbuddy-client.js');
      const client = new WorkBuddyClient(config);
      value = operation === 'native_snapshot' ? client.runSnapshot(params.attemptId) ?? null : { requested: client.cancel(params.attemptId) };
    } else if (operation === 'native_session' || operation === 'native_create') {
      const { workerRegistration } = await at('workspace-manager.js');
      const { NativeDesktopRpcTrigger } = await at('native-desktop-trigger.js');
      const registration = workerRegistration(config);
      if (!registration) throw fault('NEEDS_SETUP', 'Original native connector service must already be configured');
      const { registeredServiceConfig } = await at('persistent-service.js');
      // autoLaunch=false: inspection/creation must never restart or migrate the desktop service.
      const trigger = new NativeDesktopRpcTrigger(registeredServiceConfig(config, registration), registration.cdpPort, false);
      try { value = operation === 'native_session' ? await trigger.inspect(params.sessionId)
        : await trigger.createWorker(params.workspace, params.sessionId, params.title); }
      finally { trigger.close(); }
    } else throw fault('INVALID_OPERATION', 'Unsupported native operation');
    console.log(JSON.stringify(value));
    process.exit(0); // Do not start a second MCP server after the preload's one operation.
  } catch (error) { console.log(JSON.stringify({ error: { code: error.code ?? 'CONNECTOR_ERROR' } })); process.exit(1); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 1048576) throw new Error('Input too large'); }
    const [provider, dir, operation] = process.argv.slice(2);
    console.log(JSON.stringify(await helper(provider, dir, operation, JSON.parse(input || '{}'))));
  } catch (error) {
    console.log(JSON.stringify({ error: { code: error.admissionRejected ? 'ADMISSION_REJECTED' : error.code ?? 'CONNECTOR_ERROR' } })); process.exitCode = 1;
  }
}
