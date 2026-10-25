import { randomUUID } from 'node:crypto';
import { capabilities, fault, unknown, required, sameWorkspace, configOf, bindingOf, persist, baseBinding,
  warnMcp, check, pause, gatewayCall, questions, supervise } from './native-gateway.mjs';

const SUPPORTED_VERSION = '0.2.0-rc.2';
export function createAdapter(options = {}) {
  const call = options.call ?? ((c, op, p) => gatewayCall('harness', c, op, p));
  const q = questions();
  async function health(config = {}) {
    try {
      required(config.gatewayDir, 'gatewayDir'); required(config.hostId, 'hostId');
      const h = await call(config, 'health', { hostId: config.hostId });
      if (h.hostId !== config.hostId || h.protocolVersion !== 1 || h.version !== SUPPORTED_VERSION || !h.nativePersistence)
        return { state: 'incompatible', version: h.version, message: 'Requires Harness session-controller 0.2.0-rc.2, protocol 1 and native persistence' };
      return { state: 'available', version: h.version, message: 'Requires existing codex-workbuddy-gateway connector; MCP auto-handoff unavailable; permissions/clarifications handled in Harness UI' };
    } catch { return { state: 'needs_setup', message: 'Configure gatewayDir and explicit hostId for the existing Harness connector' }; }
  }
  async function validate(c, ctx, b) {
    if (b.hostId !== c.hostId || b.gatewayDir !== c.gatewayDir) throw fault('BINDING_MISMATCH', 'Harness connector or host changed');
    if ((await health(c)).state !== 'available') throw unknown('Harness connector version changed or is unavailable; saved execution must not be resubmitted');
    const s = await call(c, 'session', { hostId: b.hostId, sessionId: b.sessionId });
    if (s.sessionId !== b.sessionId) throw fault('BINDING_MISMATCH', 'Harness session changed');
    await sameWorkspace(s.workspace ?? s.cwd, ctx.run.workspace);
    return s;
  }
  async function read(ctx, c, b) {
    let cursor = -1; const asked = new Set();
    for (;;) {
      check(ctx);
      let page;
      try { page = await call(c, 'events', { hostId: b.hostId, sessionId: b.sessionId, requestId: b.requestId, afterSeq: cursor, limit: 100 }); }
      catch { throw unknown('Harness events unavailable; recover the saved request without prompting again'); }
      if (!Array.isArray(page.events) || !Number.isSafeInteger(page.cursor) || page.cursor < cursor) throw unknown('Invalid Harness event cursor');
      let lastSeq = cursor;
      for (const e of page.events) {
        if (e.requestId !== b.requestId || !Number.isSafeInteger(e.seq) || e.seq <= lastSeq || e.seq > page.cursor) throw unknown('Harness event request/sequence mismatch');
        lastSeq = e.seq;
        if (e.turnId) {
          if (b.turnId && b.turnId !== e.turnId) throw unknown('Harness event turn mismatch');
          if (!b.turnId) { b = { ...b, turnId: e.turnId }; await persist(ctx, b); }
        }
        if (e.type === 'completed') {
          if (!b.turnId || !e.turnId || !e.text?.trim()) throw unknown('Harness completion lacks bound turn or final text');
          b = { ...b, terminal: true }; await persist(ctx, b);
          return { text: e.text, artifacts: e.artifacts ?? [], nativeSessionId: b.sessionId, nativeBinding: b };
        }
        if (['failed', 'cancelled'].includes(e.type)) {
          await persist(ctx, { ...b, terminal: true }); throw fault('NATIVE_FAILED', `Harness ${e.type}`);
        }
        if (e.type === 'waiting_input' && !asked.has(e.seq)) {
          asked.add(e.seq);
          ctx.emit?.({ type: 'waiting', text: 'Harness 原生界面需要处理权限或提问；当前 bridge 没有代答接口。' });
          // No supported answer RPC exists. User handles the exact native question in the app.
          await q.ask(ctx, { kind: 'approval', text: '请在 Harness 原生界面处理待确认事项，完成后继续查询。', nativeRequestId: `${b.requestId}:${e.seq}` });
        }
      }
      cursor = page.cursor;
      await pause(ctx, options.pollMs ?? 300);
    }
  }
  async function execute(ctx) {
    warnMcp(ctx); check(ctx);
    const c = configOf(ctx); required(c.gatewayDir, 'gatewayDir'); required(c.hostId, 'hostId');
    if ((await health(c)).state !== 'available') throw fault('INCOMPATIBLE', 'Harness connector health/version check failed');
    let b = bindingOf(ctx, 'harness');
    if (b?.attemptId === ctx.run.attemptId && b.requestId) return recover(ctx);
    if (b?.requestId && !b.terminal) throw unknown('Previous Harness request has no terminal evidence');
    if (!b && c.sessionId) b = baseBinding(ctx, 'harness', { sessionId: c.sessionId, hostId: c.hostId, gatewayDir: c.gatewayDir });
    if (!b) {
      // Persist creation uncertainty before a non-idempotent create RPC.
      b = baseBinding(ctx, 'harness', { hostId: c.hostId, gatewayDir: c.gatewayDir, creating: true }); await persist(ctx, b);
      let s;
      try { s = await call(c, 'create', { hostId: c.hostId, workspace: ctx.run.workspace, title: `UNagent · ${ctx.participant.name ?? ctx.participant.id}` }); }
      catch { throw unknown('Harness session creation uncertain; inspect native sessions, do not create again'); }
      b = { ...b, sessionId: required(s.sessionId, 'native sessionId'), creating: false }; await persist(ctx, b);
    }
    if (!b.sessionId) throw unknown('Harness session creation has no saved receipt; inspect original host');
    const s = await validate(c, ctx, b);
    if (s.busy || s.running || s.activeRequestId) throw fault('SESSION_BUSY', 'Harness session is busy');
    b = { ...b, attemptId: ctx.run.attemptId, requestId: randomUUID(), turnId: undefined, terminal: false };
    await persist(ctx, b); check(ctx);
    try {
      const receipt = await call(c, 'prompt', { hostId: b.hostId, sessionId: b.sessionId, requestId: b.requestId, text: ctx.run.content });
      if (!receipt.accepted || receipt.requestId !== b.requestId) throw unknown('Harness admission identity was not confirmed');
      b = { ...b, turnId: receipt.turnId }; await persist(ctx, b);
    } catch (error) {
      if (error.code === 'ADMISSION_REJECTED') { await persist(ctx, { ...b, terminal: true }); throw fault('NATIVE_REJECTED', 'Harness explicitly rejected admission'); }
      throw unknown('Harness dispatch outcome unknown; recover persisted request, never resend');
    }
    return supervise(() => read(ctx, c, b));
  }
  async function recover(ctx) {
    const c = configOf(ctx), b = bindingOf(ctx, 'harness');
    if (!b?.requestId || b.attemptId !== ctx.run.attemptId) throw unknown('No Harness request bound to this attempt');
    return supervise(async () => { await validate(c, ctx, b); return read(ctx, c, b); });
  }
  async function cancel(ctx) {
    q.abort(ctx);
    try {
      const c = configOf(ctx), b = bindingOf(ctx, 'harness');
      if (!b?.requestId || b.attemptId !== ctx.run.attemptId) return { stopped: false };
      await validate(c, ctx, b);
      await call(c, 'cancel', { hostId: b.hostId, sessionId: b.sessionId, requestId: b.requestId });
      const page = await call(c, 'events', { hostId: b.hostId, sessionId: b.sessionId, requestId: b.requestId, afterSeq: -1, limit: 256 });
      const stopped = page.events?.some(e => e.requestId === b.requestId && (!b.turnId || e.turnId === b.turnId)
        && ['completed', 'failed', 'cancelled'].includes(e.type)) === true;
      if (stopped) await persist(ctx, { ...b, terminal: true });
      return { stopped };
    } catch { return { stopped: false }; }
  }
  return { id: 'harness', capabilities: { ...capabilities, connectorPackage: 'codex-workbuddy-gateway + Harness bridge' }, health, execute, recover, cancel };
}
