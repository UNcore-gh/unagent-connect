import { createHash } from 'node:crypto';
import { capabilities, fault, unknown, required, configOf, bindingOf, persist, baseBinding,
  warnMcp, check, pause, bridgeCall, questions, supervise } from './native-gateway.mjs';

const key = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const scope = ctx => `unagent-connect:${key(ctx.participant.id, ctx.run.workspace)}`;
const exactTaskSession = (task, binding) => task?.id === binding.taskId && task?.targetSessionId === binding.sessionId;
const stoppedProof = (task, binding) => {
  const proof = task?.stopConfirmation;
  return exactTaskSession(task, binding) && task.status === 'cancelled'
    && proof?.taskId === binding.taskId && proof?.targetSessionId === binding.sessionId
    && proof?.state === 'stopped' && typeof proof.confirmedAt === 'number' && Number.isFinite(proof.confirmedAt);
};
const endedSegmentProof = (task, binding) => {
  const proof = task?.runtimeSegmentProof;
  return exactTaskSession(task, binding) && proof?.taskId === binding.taskId
    && proof?.targetSessionId === binding.sessionId && proof?.state === 'ended'
    && typeof proof.segmentId === 'string' && proof.segmentId.length > 0
    && typeof proof.endedAt === 'number' && Number.isFinite(proof.endedAt);
};
export function createAdapter(options = {}) {
  const call = options.call ?? bridgeCall, q = questions();
  const invoke = (c, method, params, ctx, suffix) => call(c, method, params, key(c.instanceId, c.clientProfile, ctx.run.attemptId, suffix));
  function setup(c) {
    for (const name of ['bridgeDir', 'instanceId', 'clientProfile']) required(c[name], `config.${name}`);
  }
  function locator(c, b) {
    if (b.instanceId !== c.instanceId || b.clientProfile !== c.clientProfile || b.bridgeDir !== c.bridgeDir)
      throw fault('BINDING_MISMATCH', 'UNagent connector identity changed');
    if (b.hubAware !== undefined && b.hubAware !== (c.hubAware === true)) throw fault('BINDING_MISMATCH', 'UNagent hubAware mode changed for an existing session');
  }
  function hubContext(ctx) {
    const env = ctx.mcpConfig?.env;
    const url = required(env?.UNAGENT_CONNECT_URL, 'ctx.mcpConfig.env.UNAGENT_CONNECT_URL');
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw fault('NEEDS_SETUP', 'Hub URL must be a local HTTP endpoint without credentials');
    if (env.UNAGENT_CONNECT_RUN_ID && env.UNAGENT_CONNECT_RUN_ID !== ctx.run.id) throw fault('BINDING_MISMATCH', 'Hub execution credential belongs to another run');
    return { url, runId: required(ctx.run.id, 'ctx.run.id'), executionToken: required(env.UNAGENT_CONNECT_EXECUTION_TOKEN, 'ctx.mcpConfig.env.UNAGENT_CONNECT_EXECUTION_TOKEN') };
  }
  async function health(c = {}) {
    try { setup(c); await call(c, 'models.list', {}, key('health', c.instanceId, c.clientProfile, Date.now()));
      return { state: 'available', message: c.hubAware === true
        ? 'Bridge reachable; hubAware additionally requires daemon/plugin connect.submit support (validated by native admission)'
        : 'Requires bridge connector 0.1.1 or 0.2.x and explicit paired instance/client; legacy mode has no automatic handoff' };
    } catch (e) { return { state: e.code === 'INCOMPATIBLE' ? 'incompatible' : 'needs_setup', message: 'Configure original bridgeDir, instanceId and paired clientProfile' }; }
  }
  async function session(ctx, c, b, idle = false) {
    locator(c, b);
    const sessions = await invoke(c, 'sessions.list', {}, ctx, `sessions:${Date.now()}`);
    const s = sessions.find?.(s => s.id === b.sessionId);
    if (!s || (s.purpose ?? s.collaboration?.purpose) !== scope(ctx))
      throw fault('BINDING_MISMATCH', 'UNagent session must carry this participant/project purpose marker');
    if (idle && (s.running !== false || s.queued !== 0)) throw fault('SESSION_BUSY', 'UNagent session is busy or idle state is unverified');
    return s;
  }
  async function read(ctx, c, b) {
    const asked = new Set(); let lastState;
    for (;;) {
      check(ctx);
      let t;
      try { t = await invoke(c, 'tasks.get', { taskId: b.taskId }, ctx, `get:${Date.now()}`); }
      catch { throw unknown('UNagent task query unavailable; recover saved receipt without sessions.send'); }
      if (t.id !== b.taskId || (t.targetSessionId && t.targetSessionId !== b.sessionId)) throw unknown('UNagent task receipt identity mismatch');
      if (t.status !== lastState) { ctx.emit?.({ type: 'status', text: `UNagent 原生任务状态：${t.status}` }); lastState = t.status; }
      if (t.status === 'completed') {
        const text = typeof t.result === 'string' ? t.result : t.result?.text;
        if (!text?.trim()) throw unknown('UNagent completed without a final result');
        b = { ...b, terminal: true }; await persist(ctx, b);
        return { text, artifacts: t.result?.artifacts ?? [], nativeSessionId: b.sessionId, nativeBinding: b };
      }
      if (t.status === 'cancelled') {
        if (!stoppedProof(t, b)) throw unknown('UNagent cancellation has no matching stopped proof; retain the native lock');
        await persist(ctx, { ...b, terminal: true });
        throw fault('NATIVE_FAILED', 'UNagent cancelled');
      }
      if (t.status === 'failed') {
        if (!endedSegmentProof(t, b)) throw unknown('UNagent failure has no matching ended runtime segment; retain the native lock');
        await persist(ctx, { ...b, terminal: true });
        throw fault('NATIVE_FAILED', 'UNagent failed');
      }
      if (t.status === 'waiting_origin') {
        const questionId = required(t.question?.questionId, 'native questionId');
        if (b.answeredQuestionId === questionId && !asked.has(questionId)) throw unknown('Previously answered UNagent question is still pending; inspect delivery without repeating answer');
        if (!asked.has(questionId)) {
          asked.add(questionId);
          const result = await q.ask(ctx, { kind: 'clarification', text: t.question.text, options: t.question.options, nativeRequestId: questionId });
          check(ctx);
          if (typeof result?.answer !== 'string') throw unknown('UNagent clarification has no authorized answer');
          // Persist an answer intent; after a transport loss recovery only reads its native task.
          b = { ...b, answeredQuestionId: questionId }; await persist(ctx, b);
          try { await invoke(c, 'tasks.answer', { taskId: b.taskId, questionId, answer: result.answer }, ctx, `answer:${questionId}`); }
          catch { throw unknown('UNagent clarification delivery uncertain; query the original task'); }
        }
      } else if (['waiting_user', 'interrupted'].includes(t.status) && !asked.has(t.status)) {
        asked.add(t.status);
        await q.ask(ctx, { kind: 'approval', text: '请在 Obsidian 中处理当前审批或恢复，再继续查询。', nativeRequestId: `${b.taskId}:${t.status}` });
      }
      await pause(ctx, options.pollMs ?? 300);
    }
  }
  async function execute(ctx) {
    check(ctx); const c = configOf(ctx); setup(c);
    const hub = c.hubAware === true ? hubContext(ctx) : undefined;
    if (!hub) warnMcp(ctx);
    let b = bindingOf(ctx, 'unagent');
    if (b?.attemptId === ctx.run.attemptId && b.dispatching) return recover(ctx);
    if (b?.dispatching && !b.terminal) throw unknown('Previous UNagent task lacks terminal evidence');
    if (!b && c.sessionId) b = baseBinding(ctx, 'unagent', { sessionId: c.sessionId, instanceId: c.instanceId, clientProfile: c.clientProfile, bridgeDir: c.bridgeDir });
    if (!b) {
      required(c.modelId, 'config.modelId from models.list');
      const catalog = await invoke(c, 'models.list', {}, ctx, 'catalog');
      if (!catalog.some?.(m => m.id === c.modelId)) throw fault('NEEDS_SETUP', 'Selected model is not in the live UNagent catalog');
      b = baseBinding(ctx, 'unagent', { instanceId: c.instanceId, clientProfile: c.clientProfile, bridgeDir: c.bridgeDir, creating: true });
      await persist(ctx, b);
      let s;
      try { s = await invoke(c, 'sessions.create', { title: `UNagent · ${ctx.participant.name ?? ctx.participant.id}`, modelId: c.modelId, purpose: scope(ctx) }, ctx, 'create'); }
      catch { throw unknown('UNagent session creation outcome unknown; inspect existing sessions before rebinding'); }
      b = { ...b, sessionId: required(s.id, 'native sessionId'), creating: false }; await persist(ctx, b);
    }
    if (!b.sessionId) throw unknown('UNagent has an uncertain session creation; no repeat create');
    await session(ctx, c, b, true);
    b = { ...b, attemptId: ctx.run.attemptId, dispatching: true, taskId: undefined, terminal: false, answeredQuestionId: undefined, hubAware: Boolean(hub) };
    await persist(ctx, b); check(ctx);
    try {
      const method = hub ? 'connect.submit' : 'sessions.send';
      const idempotencyKey = key(c.instanceId, c.clientProfile, ctx.run.attemptId, 'send');
      const params = hub ? { sessionId: b.sessionId, content: ctx.run.content, idempotencyKey, hub }
        : { sessionId: b.sessionId, content: ctx.run.content, kind: 'task' };
      const r = await invoke(c, method, params, ctx, 'send');
      b = { ...b, taskId: required(r.task?.id, 'native taskId') }; await persist(ctx, b);
      if (hub) ctx.emit?.({ type: 'capability', text: '已通过 connect.submit 绑定本轮 Hub 上下文；自动转交由 UNagent 原生 connect_* 工具处理。', data: { automaticHandoff: true } });
    } catch (error) {
      if (hub && error.code === 'METHOD_NOT_FOUND') {
        // Explicit protocol rejection happened before admission; do not silently use legacy send.
        await persist(ctx, { ...b, terminal: true, dispatching: false });
        throw fault('NEEDS_SETUP', 'hubAware requires a new daemon and plugin supporting connect.submit; the connected daemon/plugin returned METHOD_NOT_FOUND. Upgrade/restart the intended bridge explicitly; no legacy fallback was sent');
      }
      throw unknown('UNagent dispatch outcome unknown; do not send another task');
    }
    return supervise(() => read(ctx, c, b));
  }
  async function recover(ctx) {
    const c = configOf(ctx), b = bindingOf(ctx, 'unagent'); setup(c);
    if (!b?.taskId || b.attemptId !== ctx.run.attemptId) throw unknown('No durable UNagent task receipt for this attempt; inspect the original session');
    return supervise(async () => { await session(ctx, c, b); return read(ctx, c, b); });
  }
  async function cancel(ctx) {
    q.abort(ctx);
    try {
      const c = configOf(ctx), b = bindingOf(ctx, 'unagent');
      if (!b?.taskId || b.attemptId !== ctx.run.attemptId) return { stopped: false };
      locator(c, b);
      await invoke(c, 'tasks.cancel', { taskId: b.taskId }, ctx, 'cancel');
      const t = await invoke(c, 'tasks.get', { taskId: b.taskId }, ctx, `cancel-read:${Date.now()}`);
      const identityMatches = exactTaskSession(t, b);
      const stopped = identityMatches && (t.status === 'completed' || stoppedProof(t, b) ||
        (t.status === 'failed' && endedSegmentProof(t, b)));
      if (stopped) await persist(ctx, { ...b, terminal: true });
      return { stopped };
    } catch { return { stopped: false }; }
  }
  return { id: 'unagent', capabilities: { ...capabilities, hubAwareExecution: true, connectorPackage: 'unagent-connect bridge CLI 0.1.1 or 0.2.x (+ daemon/plugin connect.submit for hubAware)' }, health, execute, recover, cancel };
}
