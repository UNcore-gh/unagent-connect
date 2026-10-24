import { randomUUID } from 'node:crypto';
import { capabilities, failure, deferred, text, id, bounded, mcpEntry, executable, workspace,
  attemptKey, projectKey, binding, owned, reserve, questionQueue, deadline, waitStopped, LIMIT, isScopedHubTool, nativeResult } from './coding-native.mjs';

// Official SDK query/streaming input, exact resume, and canUseTool callback:
// https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
// https://code.claude.com/docs/en/agent-sdk/user-input
// https://code.claude.com/docs/en/agent-sdk/sessions
export function createAdapter(options = {}) {
  const active = new Map(), sessions = new Map(), uncertain = new Set();
  const loadSDK = options.loadSDK ?? (() => import('@anthropic-ai/claude-agent-sdk'));
  const stopMs = options.stopTimeoutMs ?? 5000;

  async function cancel(ctx) {
    const s = active.get(attemptKey(ctx));
    if (!s) return { stopped: false };
    s.cancelRequested = true; s.questions.abort();
    if (s.query && !s.interruptSent && !s.terminal) {
      s.interruptSent = true;
      // SDK ACK and process disposal are not proof that tools stopped.
      Promise.resolve().then(() => s.query.interrupt()).catch(() => {});
    }
    return waitStopped(s, stopMs);
  }

  return {
    id: 'claude', capabilities,
    async health() {
      try {
        const sdk = await loadSDK();
        if (typeof sdk.query !== 'function') return { state: 'incompatible', message: 'Installed Claude SDK has no query API.' };
        return { state: 'available', message: 'Claude Agent SDK found; credentials and model access are not yet verified.' };
      } catch { return { state: 'needs_setup', message: 'Install @anthropic-ai/claude-agent-sdk before automatic execution.' }; }
    },
    cancel,
    async execute(ctx) {
      const cwd = await workspace(ctx), config = ctx.participant.config ?? {};
      const duration = deadline(ctx, options.maxRunMs);
      if (ctx.signal?.aborted) throw failure('CANCELLED', 'Run cancelled before native admission');
      const mcp = mcpEntry(ctx.mcpConfig), key = projectKey(ctx, cwd), cached = sessions.get(key);
      const resumeId = ctx.run.nativeSessionId ?? config.nativeSessionId ?? cached?.nativeSessionId;
      const sessionId = resumeId ? id(resumeId) : randomUUID();
      if (uncertain.has(sessionId)) throw failure('OUTCOME_UNKNOWN', 'Claude session has an unresolved previous outcome; do not resubmit');
      const priorBinding = ctx.run.nativeBinding ?? cached;
      // SDK metadata has cwd but no authoritative idle/busy state for arbitrary
      // CLI sessions. Never attach merely because a session file exists.
      if (resumeId && !owned(priorBinding, 'claude', ctx, cwd, resumeId)) {
        throw failure('BINDING_UNVERIFIED', 'Claude can only resume this participant/project dedicated Hub session; external idle state cannot be verified');
      }
      const releaseProject = reserve(`claude:project:${key}`);
      let releaseSession;
      try { releaseSession = reserve(`claude:session:${sessionId}`); }
      catch (e) { releaseProject(); throw e; }
      const s = { admitted: false, terminal: null, finished: deferred(), failure: deferred(), questions: new AbortController(),
        inputDone: deferred(), cancelRequested: false, sessionId, outputBytes: 0, eventCount: 0, requests: 0, query: null };
      const nativeBinding = binding('claude', ctx, cwd, sessionId);
      const askNative = questionQueue(ctx, s.questions.signal);
      let timer, onAbort;
      try {
        const sdk = await loadSDK();
        if (typeof sdk.query !== 'function') throw failure('INCOMPATIBLE', 'Claude SDK query API unavailable');
        const queryOptions = { cwd, permissionMode: 'default', persistSession: true,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          // Load the native project rules, skills, tools and local settings.
          settingSources: ['user', 'project', 'local'],
          ...(resumeId ? { resume: sessionId } : { sessionId }),
          // SDK serializes mcpServers to --mcp-config argv. Credentials belong
          // only in the native process environment inherited by its MCP child.
          ...(mcp ? { env: { ...process.env, ...mcp.env },
            mcpServers: { 'unagent-connect': { type: 'stdio', command: mcp.command, args: mcp.args } } } : {}),
          canUseTool: async (toolName, input, requestOptions = {}) => {
            if (s.questions.signal.aborted || requestOptions.signal?.aborted) return { behavior: 'deny', message: 'Run cancelled', interrupt: true };
            if (mcp && isScopedHubTool(toolName)) {
              bounded(input, 128 * 1024);
              return { behavior: 'allow', updatedInput: input };
            }
            if (++s.requests > 16) { s.requests--; throw failure('DATA_LIMIT', 'Too many outstanding native questions'); }
            try {
              const preview = bounded(input, 8192);
              const question = toolName === 'AskUserQuestion';
              const ask = q => askNative({ ...q,
                nativeRequestId: text(requestOptions.toolUseID, 256) || undefined }, requestOptions.signal);
              if (question) {
                if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) return { behavior: 'deny', message: 'Invalid native questions' };
                const answers = Object.create(null);
                for (const q of input.questions) {
                  if (typeof q.question !== 'string' || !q.question.length || q.question.length > 4096) return { behavior: 'deny', message: 'Invalid native question' };
                  const reply = await ask({ kind: 'clarification', text: q.question,
                    options: (q.options ?? []).slice(0, 8).map(o => text(o.label, 160)) });
                  if (typeof reply?.answer !== 'string') return { behavior: 'deny', message: 'No valid clarification answer supplied' };
                  answers[q.question] = text(reply.answer, 8192);
                }
                return { behavior: 'allow', updatedInput: { ...input, answers } };
              }
              const reply = await ask({ kind: 'approval',
                text: `${text(requestOptions.title, 1024) || text(toolName, 256)}\n${preview}` });
              if (s.questions.signal.aborted || requestOptions.signal?.aborted) return { behavior: 'deny', message: 'Run cancelled', interrupt: true };
              return reply?.approved === true ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Administrator declined tool approval' };
            } catch (e) {
              if (s.questions.signal.aborted || requestOptions.signal?.aborted) return { behavior: 'deny', message: 'Run cancelled', interrupt: true };
              s.failure.reject(e);
              return { behavior: 'deny', message: 'Approval unavailable', interrupt: true };
            } finally { s.requests--; }
          } };
        if (config.model != null) queryOptions.model = id(config.model);
        if (config.executable != null) queryOptions.pathToClaudeCodeExecutable = executable(config.executable);
        if (config.maxTurns != null) {
          if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1 || config.maxTurns > 1000) throw failure('INVALID_CONFIG', 'Invalid Claude maxTurns');
          queryOptions.maxTurns = config.maxTurns;
        }
        // Only the allowlisted options above are passed; no bypassPermissions,
        // continue, arbitrary shell, permission updates or provider overrides.
        await ctx.saveBinding({ nativeSessionId: sessionId, nativeBinding });
        sessions.set(key, nativeBinding);
        if (ctx.signal?.aborted) throw failure('CANCELLED', 'Cancelled before native query');
        active.set(attemptKey(ctx), s);
        onAbort = () => { cancel(ctx).then(result => {
          if (!result.stopped) s.failure.reject(failure('OUTCOME_UNKNOWN', 'Claude stop has no matching terminal evidence'));
        }).catch(e => s.failure.reject(e)); };
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { cancel(ctx).then(result => {
          s.failure.reject(failure(result.stopped ? 'DEADLINE_EXCEEDED' : 'OUTCOME_UNKNOWN', 'Claude run deadline exceeded'));
        }).catch(e => s.failure.reject(e)); }, duration);
        async function* prompt() {
          yield { type: 'user', message: { role: 'user', content: ctx.run.content },
            parent_tool_use_id: null, session_id: sessionId };
          // Keep streaming input alive so canUseTool/interrupt remain supported.
          await s.inputDone.promise;
        }
        // Admission is uncertain from the instant query may start a native child.
        s.admitted = true;
        s.query = sdk.query({ prompt: prompt(), options: queryOptions });
        if (!s.query || typeof s.query.next !== 'function' || typeof s.query.interrupt !== 'function' || typeof s.query.close !== 'function') {
          throw failure('INCOMPATIBLE', 'Claude SDK query lacks streaming controls');
        }
        for (;;) {
          const next = await Promise.race([s.query.next(), s.failure.promise]);
          if (next.done) throw failure('OUTCOME_UNKNOWN', 'Claude stream ended without a result');
          const msg = next.value;
          bounded(msg);
          if (++s.eventCount > 100_000) throw failure('DATA_LIMIT', 'Too many SDK messages');
          if (!msg || typeof msg !== 'object') throw failure('NATIVE_PROTOCOL', 'Invalid Claude SDK event');
          if (msg.session_id != null && msg.session_id !== sessionId) throw failure('NATIVE_PROTOCOL', 'Claude returned a different session identifier');
          if (mcp && msg.type === 'system' && msg.subtype === 'init') {
            const server = Array.isArray(msg.mcp_servers) && msg.mcp_servers.find(x => x.name === 'unagent-connect');
            if (!server || server.status !== 'connected') {
              s.mcpFailed = true;
              cancel(ctx).then(result => {
                if (!result.stopped) s.failure.reject(failure('OUTCOME_UNKNOWN', 'Hub MCP unavailable and native stop remains unconfirmed'));
              }).catch(e => s.failure.reject(e));
            }
          }
          if (msg.type === 'assistant') {
            const blocks = msg.message?.content;
            if (!Array.isArray(blocks) || blocks.length > 1024) throw failure('NATIVE_PROTOCOL', 'Invalid assistant content');
            const output = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
            s.outputBytes += Buffer.byteLength(output);
            if (s.outputBytes > LIMIT) throw failure('DATA_LIMIT', 'Claude answer exceeds size limit');
            if (s.eventCount <= 16 && output) ctx.emit?.({ type: 'progress', text: text(output, 2000) });
          }
          if (msg.type !== 'result') continue;
          if (msg.session_id !== sessionId) throw failure('NATIVE_PROTOCOL', 'Claude result missing matching session');
          s.terminal = msg; s.finished.resolve(); s.questions.abort();
          if (s.mcpFailed) throw failure('MCP_UNAVAILABLE', 'Claude could not connect to the scoped Hub MCP entry');
          if (s.cancelRequested || ['aborted_streaming', 'aborted_tools'].includes(msg.terminal_reason)) {
            throw failure('CANCELLED', 'Claude query termination confirmed');
          }
          if (msg.subtype !== 'success' || msg.is_error !== false ||
              (msg.terminal_reason != null && msg.terminal_reason !== 'completed') || msg.stop_reason === 'max_tokens') {
            throw failure('NATIVE_FAILED', 'Claude query explicitly ended without successful completion');
          }
          if (typeof msg.result !== 'string' || Buffer.byteLength(msg.result) > LIMIT) throw failure('DATA_LIMIT', 'Invalid or oversized Claude result');
          return { ...nativeResult(msg.result), nativeSessionId: sessionId, nativeBinding };
        }
      } catch (e) {
        if (s.admitted && !s.terminal) {
          uncertain.add(sessionId);
          throw failure('OUTCOME_UNKNOWN', 'Claude query was admitted but its terminal outcome is unconfirmed');
        }
        throw e;
      } finally {
        clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort);
        s.questions.abort(); s.inputDone.resolve(); s.finished.resolve();
        // Closing is resource cleanup only; cancel() never infers stopped from it.
        try { s.query?.close(); } catch { /* preserve the execution outcome */ }
        active.delete(attemptKey(ctx)); releaseSession(); releaseProject();
      }
    },
  };
}
