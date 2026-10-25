import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { NativeRpc, LIMIT, capabilities, failure, deferred, text, id, bounded, executable,
  mcpEntry, workspace, attemptKey, projectKey, binding, owned, reserve, questionQueue, deadline, waitStopped, hubToolNames, nativeResult } from './coding-native.mjs';

// Protocol: https://learn.chatgpt.com/docs/app-server
// Runtime -c overrides are process-local. Never use config/write or global files.
function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function launch(config, mcp) {
  const args = [];
  if (mcp) {
    // Keep attempt credentials out of argv (env_vars passes them to the MCP child).
    // CLI -c splits dotted paths itself; quotes here become literal characters
    // in the server name (native -32603). This name needs no quoting.
    args.push('-c', `mcp_servers.unagent-connect=${toml({ command: mcp.command, args: mcp.args,
      env_vars: Object.keys(mcp.env), required: true, enabled_tools: hubToolNames,
      default_tools_approval_mode: 'approve' })}`);
  }
  args.push('app-server', '--listen', 'stdio://');
  return { command: executable(config.executable ?? config.command, 'codex'), args,
    env: mcp ? { ...process.env, ...mcp.env } : process.env };
}
function settings(config, cwd) {
  const sandbox = config.sandbox ?? 'workspace-write';
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw failure('INVALID_CONFIG', 'Unsupported Codex sandbox');
  const result = { cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox };
  if (config.model != null) { id(config.model); result.model = config.model; }
  return result;
}

export function createAdapter(options = {}) {
  const active = new Map(), sessions = new Map(), uncertain = new Set();
  const stopMs = options.stopTimeoutMs ?? 5000;
  const makeRpc = options.rpcFactory ?? ((command, args, opts) => new NativeRpc(command, args, opts));

  async function cancel(ctx) {
    const s = active.get(attemptKey(ctx));
    if (!s) return { stopped: false };
    s.cancelRequested = true;
    s.questions.abort();
    if (!s.admitted) return { stopped: false };
    if (s.turnId && !s.interruptSent && !s.terminal) {
      s.interruptSent = true;
      // An interrupt ACK alone is not terminal evidence.
      s.rpc.request('turn/interrupt', { threadId: s.sessionId, turnId: s.turnId }).catch(() => {});
    }
    return waitStopped(s, stopMs);
  }

  return {
    id: 'codex', capabilities,
    async health(config = {}) {
      try {
        const { stdout } = await (options.execFile ?? promisify(execFile))(
          executable(config.executable ?? config.command, 'codex'), ['--version'], { timeout: 5000, maxBuffer: 4096 });
        const version = text(stdout, 128).trim();
        return { state: 'available', version, message: 'Codex CLI found; login and project execution still require acceptance testing.' };
      } catch { return { state: 'needs_setup', message: 'Codex CLI is unavailable or did not answer the version probe.' }; }
    },
    cancel,
    async execute(ctx) {
      const cwd = await workspace(ctx), config = ctx.participant.config ?? {};
      const duration = deadline(ctx, options.maxRunMs);
      if (ctx.signal?.aborted) throw failure('CANCELLED', 'Run cancelled before native admission');
      const nativeSettings = settings(config, cwd), mcp = mcpEntry(ctx.mcpConfig);
      const key = projectKey(ctx, cwd), cached = sessions.get(key);
      const resumeId = ctx.run.nativeSessionId ?? config.nativeSessionId ?? cached?.nativeSessionId;
      if (resumeId) id(resumeId);
      if (resumeId && uncertain.has(resumeId)) throw failure('OUTCOME_UNKNOWN', 'Codex session has an unresolved previous outcome; do not resubmit');
      const priorBinding = ctx.run.nativeBinding ?? cached;
      if (resumeId && priorBinding && !owned(priorBinding, 'codex', ctx, cwd, resumeId)) {
        throw failure('BINDING_UNVERIFIED', 'Codex binding belongs to a different participant or project');
      }
      const releases = [reserve(`codex:project:${key}`)];
      let rpc, timer, onAbort;
      const s = { admitted: false, turnId: null, sessionId: resumeId, terminal: null, finished: deferred(),
        outcome: deferred(), questions: new AbortController(), cancelRequested: false, early: [], earlyBytes: 0,
        messages: new Map(), outputBytes: 0, requests: new Set(), fileChanges: new Map(), changeBytes: 0 };
      const fail = e => s.outcome.reject(e);
      const askNative = questionQueue(ctx, s.questions.signal);
      const finish = turn => {
        if (!['completed', 'failed', 'interrupted'].includes(turn.status)) return;
        s.terminal = turn; s.finished.resolve(); s.questions.abort();
        s.outcome.resolve(turn);
      };
      const event = msg => {
        const p = msg.params;
        if (!p || p.threadId !== s.sessionId) return;
        const turnId = p.turnId ?? p.turn?.id;
        if (!s.turnId) {
          if (!s.admitted) return;
          const bytes = Buffer.byteLength(bounded(msg));
          if (s.early.length >= 128 || s.earlyBytes + bytes > LIMIT) return fail(failure('DATA_LIMIT', 'Too many early native events'));
          s.early.push(msg); s.earlyBytes += bytes; return;
        }
        if (turnId !== s.turnId) return;
        if (msg.method === 'item/started' && p.item?.type === 'fileChange') {
          const changeId = id(p.item.id), preview = bounded(p.item.changes, 8192);
          s.changeBytes += Buffer.byteLength(preview);
          if (s.fileChanges.size >= 64 || s.changeBytes > 64 * 1024) return fail(failure('DATA_LIMIT', 'Native file approval previews exceed limit'));
          s.fileChanges.set(changeId, JSON.parse(preview));
        }
        if (msg.method === 'turn/completed') finish(p.turn ?? {});
        if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') {
          const itemId = id(p.item.id), output = text(p.item.text, LIMIT + 1);
          s.outputBytes -= Buffer.byteLength(s.messages.get(itemId) ?? '');
          s.outputBytes += Buffer.byteLength(output);
          if (s.messages.size >= 1024 || s.outputBytes > LIMIT) return fail(failure('DATA_LIMIT', 'Native answer exceeds size limit'));
          s.messages.set(itemId, output);
          // Deliberately no token or reasoning events; only bounded completed public text.
          if (s.messages.size <= 16) ctx.emit?.({ type: 'progress', text: text(output, 2000) });
        }
      };
      const request = async msg => {
        const p = msg.params ?? {};
        if (p.threadId !== s.sessionId || p.turnId !== s.turnId || s.questions.signal.aborted) {
          rpc.reject(msg.id); return;
        }
        if (s.requests.has(msg.id)) throw failure('NATIVE_PROTOCOL', 'Duplicate native request identifier');
        if (s.requests.size >= 16) throw failure('DATA_LIMIT', 'Too many outstanding native questions');
        s.requests.add(msg.id);
        const ask = q => askNative({ ...q, nativeRequestId: String(msg.id) });
        const respond = result => { if (!s.questions.signal.aborted) rpc.respond(msg.id, result); };
        try {
          if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) {
            const preview = bounded({ reason: p.reason, command: p.command, cwd: p.cwd, grantRoot: p.grantRoot,
              additionalPermissions: p.additionalPermissions, networkApprovalContext: p.networkApprovalContext,
              changes: s.fileChanges.get(p.itemId) }, 8192);
            const answer = await ask({ kind: 'approval', text: `${msg.method}\n${preview}` });
            respond({ decision: answer?.approved === true ? 'accept' : 'decline' });
          } else if (msg.method === 'item/permissions/requestApproval') {
            const permissions = JSON.parse(bounded(p.permissions, 8192));
            const answer = await ask({ kind: 'approval', text: `Codex requests permissions:\n${text(p.reason, 1024)}\n${bounded(permissions, 8192)}` });
            respond({ permissions: answer?.approved === true ? permissions : {}, scope: 'turn' });
          } else if (msg.method === 'item/tool/requestUserInput' || msg.method === 'tool/requestUserInput') {
            if (!Array.isArray(p.questions) || p.questions.length > 3) throw failure('NATIVE_PROTOCOL', 'Invalid native questions');
            const answers = Object.create(null);
            for (const question of p.questions) {
              const qid = id(question.id);
              const labels = (question.options ?? []).slice(0, 8).map(o => text(o.label, 160));
              // Connector side-effect approvals arrive here too. Any approval
              // vocabulary is admin-only; no grant can come from an agent answer.
              const approval = labels.some(label => /accept|allow|approv|decline|deny|cancel|批准|允许|拒绝|取消/iu.test(label));
              const reply = await ask({ kind: approval ? 'approval' : 'clarification', text: text(question.question), options: labels });
              if (!approval) answers[qid] = { answers: [text(reply?.answer, 4096)] };
              else answers[qid] = { answers: [reply?.approved === true ? 'Accept' : 'Decline'] };
            }
            respond({ answers });
          } else if (msg.method === 'mcpServer/elicitation/request') {
            // Structured forms need schema validation beyond this adapter's contract: fail closed.
            respond({ action: 'decline', content: null });
          } else rpc.reject(msg.id);
        } catch (e) {
          if (!s.questions.signal.aborted) { rpc.reject(msg.id); throw e; }
        } finally { s.requests.delete(msg.id); }
      };
      try {
        if (resumeId) releases.push(reserve(`codex:session:${resumeId}`));
        const spec = launch(config, mcp);
        rpc = makeRpc(spec.command, spec.args, { cwd, env: spec.env,
          timeoutMs: options.rpcTimeoutMs ?? 30_000, spawnProcess: options.spawn });
        s.rpc = rpc; active.set(attemptKey(ctx), s);
        rpc.on('disconnect', fail);
        rpc.on('notification', msg => { try { event(msg); } catch (e) { fail(e); } });
        rpc.on('request', msg => {
          // Approval may precede turn/start's response. Buffer without blocking RPC replies.
          if (s.admitted && !s.turnId && msg.params?.threadId === s.sessionId) {
            try {
              s.earlyBytes += Buffer.byteLength(bounded(msg));
              if (s.early.length >= 128 || s.earlyBytes > LIMIT) throw failure('DATA_LIMIT', 'Too many early requests');
              s.early.push(msg);
            } catch (e) { fail(e); }
          } else request(msg).catch(fail);
        });
        timer = setTimeout(() => {
          cancel(ctx).then(() => fail(failure(s.admitted && !s.terminal ? 'OUTCOME_UNKNOWN' : 'DEADLINE_EXCEEDED', 'Native run deadline exceeded')), fail);
        }, duration);
        onAbort = () => { cancel(ctx).then(result => {
          if (!result.stopped) fail(failure(s.admitted ? 'OUTCOME_UNKNOWN' : 'CANCELLED', 'Native stop has no matching terminal evidence'));
        }).catch(fail); };
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        await rpc.request('initialize', { clientInfo: { name: 'unagent_connect', title: 'UNagent Connect', version: '0.2.0' },
          capabilities: { optOutNotificationMethods: ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/agentMessage/delta'] } });
        rpc.notify('initialized');
        if (s.cancelRequested) throw failure('CANCELLED', 'Cancelled before native session');
        if (resumeId) {
          const { thread } = await rpc.request('thread/read', { threadId: resumeId, includeTurns: false });
          if (thread?.id !== resumeId || !thread.cwd || await realpath(thread.cwd) !== cwd) throw failure('WORKSPACE_MISMATCH', 'Native thread project differs');
          const trusted = owned(priorBinding, 'codex', ctx, cwd, resumeId);
          const status = thread.status?.type;
          if (status !== 'idle' && !(trusted && status === 'notLoaded')) throw failure('SESSION_BUSY', 'Native thread is busy or its idle state cannot be verified');
          if (s.cancelRequested) throw failure('CANCELLED', 'Cancelled before resume');
        }
        const result = await rpc.request(resumeId ? 'thread/resume' : 'thread/start',
          { ...nativeSettings, ...(resumeId ? { threadId: resumeId, excludeTurns: true } : { ephemeral: false }) });
        s.sessionId = id(result?.thread?.id);
        if (resumeId && s.sessionId !== resumeId) throw failure('NATIVE_PROTOCOL', 'Native resume returned a different thread');
        if (!resumeId) releases.push(reserve(`codex:session:${s.sessionId}`));
        s.nativeBinding = binding('codex', ctx, cwd, s.sessionId);
        await ctx.saveBinding({ nativeSessionId: s.sessionId, nativeBinding: s.nativeBinding });
        sessions.set(key, s.nativeBinding);
        if (s.cancelRequested || ctx.signal?.aborted) throw failure('CANCELLED', 'Cancelled before native turn');
        s.admitted = true;
        let started;
        try {
          started = await rpc.request('turn/start', { threadId: s.sessionId, cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
            input: [{ type: 'text', text: ctx.run.content, text_elements: [] }] });
        } catch (e) { if (e.nativeRejected) s.admitted = false; throw e; }
        s.turnId = id(started?.turn?.id);
        s.nativeBinding = { ...s.nativeBinding, turnId: s.turnId, attemptId: ctx.run.attemptId ?? null };
        await ctx.saveBinding({ nativeSessionId: s.sessionId, nativeBinding: s.nativeBinding });
        const early = s.early; s.early = []; s.earlyBytes = 0;
        for (const msg of early) {
          if (msg.id == null) event(msg); else request(msg).catch(fail);
        }
        if (s.cancelRequested && !s.terminal) cancel(ctx).catch(fail);
        const turn = await s.outcome.promise;
        if (s.cancelRequested || turn.status === 'interrupted') throw failure('CANCELLED', 'Native turn termination confirmed');
        if (turn.status !== 'completed') throw failure('NATIVE_FAILED', 'Codex turn explicitly failed');
        return { ...nativeResult([...s.messages.values()]), nativeSessionId: s.sessionId, nativeBinding: s.nativeBinding };
      } catch (e) {
        if (s.admitted && !s.terminal) {
          if (s.sessionId) uncertain.add(s.sessionId);
          throw failure('OUTCOME_UNKNOWN', 'Codex execution was admitted but its terminal outcome is unconfirmed');
        }
        throw e;
      } finally {
        clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort);
        s.questions.abort(); s.finished.resolve(); active.delete(attemptKey(ctx));
        rpc?.close(); for (const release of releases.reverse()) release();
      }
    },
  };
}
