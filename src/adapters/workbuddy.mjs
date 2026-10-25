import { createHash, randomUUID } from 'node:crypto';
import { capabilities, fault, unknown, required, sameWorkspace, configOf, bindingOf, persist, baseBinding,
  warnMcp, check, pause, gatewayCall, questions, supervise } from './native-gateway.mjs';

export function createAdapter(options = {}) {
  const call = options.call ?? ((c, op, p) => gatewayCall('workbuddy', c, op, p)), q = questions();
  async function health(c = {}) {
    try {
      required(c.gatewayDir, 'config.gatewayDir');
      const h = await call(c, 'workbuddy_health', { sessionId: c.sessionId, detail: 'full' });
      if (!['desktop-queue', 'desktop-acp'].includes(h.backend)) return { state: 'incompatible', message: 'Requires native desktop-queue or desktop-acp connector, not CLI/hidden runtime' };
      return { state: h.online || h.persistentService?.installed ? 'available' : 'degraded', message: 'Requires existing codex-workbuddy-gateway connector; no service migration; native MCP auto-handoff unavailable' };
    } catch { return { state: 'needs_setup', message: 'Configure gatewayDir pointing to the existing native WorkBuddy connector' }; }
  }
  function locator(c, b) { if (b.gatewayDir !== c.gatewayDir) throw fault('BINDING_MISMATCH', 'WorkBuddy gateway changed'); }
  function taskIdentity(t, b) {
    if (!t || t.taskId !== b.taskId || (b.sessionId && t.sessionId !== b.sessionId)
      || (b.nativeAttemptId && t.attemptId !== b.nativeAttemptId)) throw unknown('WorkBuddy task/session/attempt identity mismatch');
  }
  // TaskStore.state=cancelled is only a request. Require the actual worker's terminal report.
  function terminal(r, b) {
    const t = r.task; taskIdentity(t, b);
    return r.messages?.findLast(m => m.metadata?.type === 'result'
      && m.metadata?.attemptId === t.attemptId && m.metadata?.sessionId === t.sessionId
      && ['needs_review', 'completed', 'failed', 'cancelled', 'blocked'].includes(m.metadata.status)
      && ['end_turn', 'cancelled', 'failed', 'blocked', 'cancelled_before_claim'].includes(m.metadata.stopReason));
  }
  async function read(ctx, c, b) {
    const asked = new Set(); let lastState;
    for (;;) {
      check(ctx); let r;
      try { r = await call(c, 'workbuddy_get_task', { taskId: b.taskId, includeMessages: true, detail: 'full' }); }
      catch { throw unknown('WorkBuddy readback unavailable; recover saved task without resubmission'); }
      taskIdentity(r.task, b);
      if (r.task.sessionId && !b.sessionId) { b = { ...b, sessionId: r.task.sessionId }; await persist(ctx, b); }
      if (r.task.attemptId && !b.nativeAttemptId) { b = { ...b, nativeAttemptId: r.task.attemptId }; await persist(ctx, b); }
      const t = r.task;
      if (t.state !== lastState) { ctx.emit?.({ type: 'status', text: `WorkBuddy 原生任务状态：${t.state}` }); lastState = t.state; }
      const snapshot = b.nativeAttemptId ? await call(c, 'native_snapshot', { attemptId: b.nativeAttemptId }) : undefined;
      if (snapshot && (snapshot.attemptId !== b.nativeAttemptId || snapshot.taskId !== b.taskId || snapshot.sessionId !== b.sessionId)) throw unknown('WorkBuddy native snapshot binding mismatch');
      const nativeEnd = snapshot && ['needs_review', 'failed', 'cancelled', 'blocked'].includes(snapshot.status)
        && ['end_turn', 'cancelled', 'failed', 'blocked', 'cancelled_before_claim'].includes(snapshot.stopReason);
      const end = terminal(r, b) ?? (nativeEnd ? { metadata: { status: snapshot.status, stopReason: snapshot.stopReason, artifacts: snapshot.artifacts } } : undefined);
      if (end) {
        b = { ...b, runtimeSource: t.runtimeSource ?? snapshot?.runtimeSource };
        if (!['desktop_interactive', 'desktop_queue'].includes(b.runtimeSource ?? '')) throw unknown('WorkBuddy terminal report has no verified native runtime source');
        b = { ...b, terminal: true }; await persist(ctx, b);
        if (!['needs_review', 'completed', 'accepted'].includes(t.state) || end.metadata.stopReason !== 'end_turn')
          throw fault('NATIVE_FAILED', `WorkBuddy terminal ${end.metadata.status}`);
        const text = t.report?.rawText ?? snapshot?.text;
        if (!text?.trim()) throw unknown('WorkBuddy ended without a final native report');
        return { text, artifacts: t.artifacts ?? end.metadata.artifacts ?? [], nativeSessionId: b.sessionId, nativeBinding: b };
      }
      const inputMessage = r.messages?.findLast(m => m.metadata?.type === 'input_request' && m.metadata?.attemptId === t.attemptId);
      const input = inputMessage?.metadata?.input;
      const requestId = inputMessage?.message_id;
      if (input && requestId && !asked.has(requestId)) {
        if (!snapshot?.waitingInput) throw unknown('WorkBuddy input request is historical, not confirmed pending');
        if (b.answeredRequestId === requestId) throw unknown('WorkBuddy answer was already attempted; inspect original request, do not answer again');
        asked.add(requestId);
        if (t.runtimeSource !== 'desktop_interactive') throw unknown('WorkBuddy queue input must be handled in its native UI; no supported reply channel');
        const approval = ['session/request_permission', 'requestPermission'].includes(input.method);
        if (!approval && !['elicitation/create', '_codebuddy.ai/question'].includes(input.method)) throw unknown('Unsupported WorkBuddy native input request');
        const description = typeof input.message === 'string' ? input.message.slice(0, 4000) : 'WorkBuddy 请求输入。';
        const form = approval ? '' : `\n请用符合原生字段要求的 JSON 对象回答：${JSON.stringify({ questions: input.questions, schema: input.requestedSchema }).slice(0, 8000)}`;
        const answer = await q.ask(ctx, { kind: approval ? 'approval' : 'clarification', text: description + form, options: approval ? input.options?.map(o => o.kind).filter(k => ['allow_once', 'reject_once'].includes(k)) : undefined, nativeRequestId: requestId });
        check(ctx);
        const decision = approval ? answer.approved === true ? 'allow_once' : 'reject_once' : 'submit';
        if (approval && !input.options?.some(o => o.kind === decision)) throw unknown('WorkBuddy did not offer this single-action approval choice');
        let content;
        if (!approval) {
          // Native forms require structured field values; never guess their field names.
          try { content = JSON.parse(answer.answer); } catch { throw unknown('WorkBuddy form answer must be a JSON object matching the native schema'); }
          if (!content || typeof content !== 'object' || Array.isArray(content)) throw unknown('WorkBuddy form answer must be a JSON object');
        }
        const latest = await call(c, 'native_snapshot', { attemptId: b.nativeAttemptId });
        if (!latest?.waitingInput || latest.attemptId !== b.nativeAttemptId || latest.sessionId !== b.sessionId) throw unknown('WorkBuddy pending request changed while awaiting answer');
        b = { ...b, answeredRequestId: requestId }; await persist(ctx, b);
        try { await call(c, 'workbuddy_respond_task', { taskId: b.taskId, decision, ...(content ? { content } : {}) }); }
        catch { throw unknown('WorkBuddy answer delivery uncertain; read original task'); }
      } else if (t.state === 'blocked' || t.state === 'cancelled') {
        throw unknown('WorkBuddy is blocked or cancellation requested without native stop evidence; inspect original session');
      }
      await pause(ctx, options.pollMs ?? 300);
    }
  }
  async function execute(ctx) {
    warnMcp(ctx); check(ctx); const c = configOf(ctx); required(c.gatewayDir, 'gatewayDir');
    let b = bindingOf(ctx, 'workbuddy');
    if (b?.attemptId === ctx.run.attemptId && b.taskId) return recover(ctx);
    if (b?.taskId && !b.terminal) throw unknown('Previous WorkBuddy run has no native terminal evidence');
    if (b) locator(c, b);
    if (b?.creating) throw unknown('WorkBuddy session creation receipt is uncertain; inspect the reserved native UUID before rebinding');
    const h = await call(c, 'workbuddy_health', { sessionId: b?.sessionId ?? c.sessionId, detail: 'full' });
    if (!['desktop-queue', 'desktop-acp'].includes(h.backend)) throw fault('INCOMPATIBLE', 'WorkBuddy requires the native desktop connector');
    let sessionId = b?.sessionId ?? c.sessionId;
    if (h.backend === 'desktop-queue') {
      // Only use the already-installed service. Do not let ensure_workspace bootstrap a service.
      if (!h.persistentService?.installed) throw fault('NEEDS_SETUP', 'Prepare the original WorkBuddy native connector service separately');
      const workers = (await call(c, 'workbuddy_list_workspaces', { detail: 'full' })).workers ?? [];
      if (sessionId) {
        const worker = workers.find(w => w.sessionId === sessionId && w.desktopRegistered);
        if (!worker) throw fault('BINDING_MISMATCH', 'Explicit WorkBuddy session is not registered in the original connector');
        await sameWorkspace(worker.workspace, ctx.run.workspace);
      } else {
        // Reserve a distinct native UUID per participant/project before native creation.
        if (b?.creating) throw unknown('WorkBuddy native session creation uncertain; inspect the reserved session');
        sessionId = randomUUID();
        b = baseBinding(ctx, 'workbuddy', { gatewayDir: c.gatewayDir, sessionId, creating: true }); await persist(ctx, b);
        let result;
        try { result = await call(c, 'native_create', { workspace: ctx.run.workspace, sessionId, title: `UNagent · ${ctx.participant.name ?? ctx.participant.id}` }); }
        catch { throw unknown('WorkBuddy session creation uncertain; inspect saved native session UUID'); }
        if (result.sessionId !== sessionId) throw unknown('WorkBuddy created another native session');
        await sameWorkspace(result.workspace, ctx.run.workspace);
        b = { ...b, creating: false }; await persist(ctx, b);
      }
    } else if (sessionId) {
      const s = h.sessions?.find(s => s.sessionId === sessionId && s.ready);
      if (!s) throw fault('BINDING_MISMATCH', 'Explicit WorkBuddy ACP session is not ready');
      await sameWorkspace(s.workspace, ctx.run.workspace);
    }
    if (sessionId) {
      const native = await call(c, 'native_session', { sessionId });
      await sameWorkspace(native.workspace, ctx.run.workspace);
      if (native.state !== 'idle') throw fault('SESSION_BUSY', 'WorkBuddy native session is not confirmed idle');
    }
    b = baseBinding(ctx, 'workbuddy', { gatewayDir: c.gatewayDir, sessionId, attemptId: ctx.run.attemptId,
      taskId: `connect-${createHash('sha256').update(JSON.stringify([ctx.participant.id, ctx.run.workspace, ctx.run.attemptId])).digest('hex')}`, terminal: false });
    await persist(ctx, b); check(ctx);
    try {
      const receipt = await call(c, 'workbuddy_send_task', { taskId: b.taskId, objective: ctx.run.content, workspace: ctx.run.workspace,
        ...(sessionId ? { sessionId, sessionMode: 'existing' } : { sessionMode: 'new' }), ...(c.modelId ? { model: c.modelId } : {}), detail: 'full' });
      taskIdentity(receipt.task, b);
      b = { ...b, sessionId: receipt.task.sessionId ?? sessionId, nativeAttemptId: receipt.task.attemptId }; await persist(ctx, b);
    } catch { throw unknown('WorkBuddy admission uncertain; recover saved task ID without send'); }
    return supervise(() => read(ctx, c, b));
  }
  async function recover(ctx) {
    const c = configOf(ctx), b = bindingOf(ctx, 'workbuddy');
    if (!b?.taskId || b.attemptId !== ctx.run.attemptId) throw unknown('No WorkBuddy task bound to this attempt');
    return supervise(async () => { locator(c, b); return read(ctx, c, b); });
  }
  async function cancel(ctx) {
    q.abort(ctx);
    try {
      const c = configOf(ctx), b = bindingOf(ctx, 'workbuddy');
      if (!b?.taskId || b.attemptId !== ctx.run.attemptId) return { stopped: false };
      locator(c, b);
      if (!b.nativeAttemptId) return { stopped: false };
      await call(c, 'native_cancel', { attemptId: b.nativeAttemptId });
      const r = await call(c, 'workbuddy_get_task', { taskId: b.taskId, includeMessages: true, detail: 'full' });
      const snapshot = await call(c, 'native_snapshot', { attemptId: b.nativeAttemptId });
      const stopped = Boolean(terminal(r, b)) || Boolean(snapshot && snapshot.attemptId === b.nativeAttemptId
        && snapshot.taskId === b.taskId && snapshot.sessionId === b.sessionId
        && ['needs_review', 'failed', 'cancelled', 'blocked'].includes(snapshot.status)
        && ['end_turn', 'cancelled', 'failed', 'blocked', 'cancelled_before_claim'].includes(snapshot.stopReason));
      if (stopped) await persist(ctx, { ...b, terminal: true });
      return { stopped };
    } catch { return { stopped: false }; }
  }
  return { id: 'workbuddy', capabilities: { ...capabilities, permissions: true, connectorPackage: 'codex-workbuddy-gateway (existing native desktop service)' }, health, execute, recover, cancel };
}
