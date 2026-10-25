import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBridgeServer } from '../scripts/bridge-server.mjs';
import { createAdapter as unagent } from '../src/adapters/unagent.mjs';
import { createAdapter as harness } from '../src/adapters/harness.mjs';
import { createAdapter as workbuddy } from '../src/adapters/workbuddy.mjs';
import { gatewayCall, bridgeCall, jsonProcess } from '../src/adapters/native-gateway.mjs';

const workspace = os.tmpdir();
function context(config = {}, provider = 'unagent') {
  const history = [], events = [];
  const ctx = { run: { id: 'r1', threadId: 'thread', workspace, content: 'do scoped work', round: 1, attemptId: 'a1', deadlineAt: Date.now() + 10000 },
    participant: { id: 'p1', name: 'Tester', provider, config }, signal: new AbortController().signal,
    emit: e => events.push(e), ask: async () => ({ answer: 'the authorized answer' }),
    saveBinding: async value => { history.push(structuredClone(value)); Object.assign(ctx.run, structuredClone(value)); } };
  return { ctx, history, events };
}
const hash = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const uaConfig = { bridgeDir: '/connector-0.1.1', instanceId: 'instance', clientProfile: 'paired', modelId: 'catalog-model' };
function uaMock(fixture, query) {
  const calls = []; let serial = 0;
  const call = async (c, op, p, idem) => {
    calls.push({ c, op, p, idem });
    if (op === 'models.list') return [{ id: 'catalog-model' }];
    if (op === 'sessions.create') return { id: 's1' };
    if (op === 'sessions.list') return [{ id: 's1', purpose: `unagent-connect:${hash('p1', workspace)}`, running: false, queued: 0 }];
    if (op === 'sessions.send') {
      assert.equal(fixture.ctx.run.nativeBinding.dispatching, true, 'intent persisted before delivery');
      return { task: { id: `t${++serial}` } };
    }
    if (op === 'tasks.get') {
      assert.equal(fixture.ctx.run.nativeBinding.taskId, p.taskId, 'receipt persisted before query');
      return query ? query(p, calls) : { id: p.taskId, targetSessionId: 's1', status: 'completed', result: 'native final' };
    }
    if (['tasks.answer', 'tasks.cancel'].includes(op)) return {};
    throw new Error(`Unexpected ${op}`);
  };
  return { call, calls };
}
test('UNagent persists receipt, supports two real native rounds in the same scoped session', async () => {
  const f = context(uaConfig), mock = uaMock(f); const adapter = unagent({ call: mock.call, pollMs: 0 });
  assert.equal((await adapter.execute(f.ctx)).text, 'native final');
  f.ctx.run.attemptId = 'a2'; f.ctx.run.round = 2; f.ctx.run.content = 'rework with feedback';
  assert.equal((await adapter.execute(f.ctx)).nativeSessionId, 's1');
  assert.equal(mock.calls.filter(c => c.op === 'sessions.create').length, 1);
  assert.equal(mock.calls.filter(c => c.op === 'sessions.send').length, 2);
  assert.equal(mock.calls.filter(c => c.op === 'sessions.send')[1].p.content, 'rework with feedback');
});
test('UNagent clarification uses exact question ID and keeps original task, never resends', async () => {
  const f = context(uaConfig); let answered = false;
  const mock = uaMock(f, p => ({ id: p.taskId, status: answered ? 'completed' : 'waiting_origin', result: answered ? 'answered final' : undefined,
    question: { questionId: 'q-native', text: 'which folder?' } }));
  const call = async (...args) => { if (args[1] === 'tasks.answer') { assert.equal(args[2].questionId, 'q-native'); answered = true; } return mock.call(...args); };
  f.ctx.ask = async q => { assert.equal(q.kind, 'clarification'); assert.equal(q.nativeRequestId, 'q-native'); return { answer: 'folder A' }; };
  assert.equal((await unagent({ call, pollMs: 0 }).execute(f.ctx)).text, 'answered final');
  assert.equal(mock.calls.filter(c => c.op === 'sessions.send').length, 1);
});
test('UNagent lost readback recovers persisted receipt without another send', async () => {
  const f = context(uaConfig); let offline = true;
  const mock = uaMock(f, p => { if (offline) throw new Error('disconnected'); return { id: p.taskId, status: 'completed', result: 'recovered' }; });
  const a = unagent({ call: mock.call }); await assert.rejects(a.execute(f.ctx), { code: 'OUTCOME_UNKNOWN' });
  offline = false; assert.equal((await a.recover(f.ctx)).text, 'recovered');
  assert.equal(mock.calls.filter(c => c.op === 'sessions.send').length, 1);
});
test('UNagent hubAware connect.submit carries only execution context, never recipient token or prompt credentials', async () => {
  const f = context({ ...uaConfig, hubAware: true }), mock = uaMock(f);
  f.ctx.mcpConfig = { command: 'unused', env: { UNAGENT_CONNECT_URL: 'http://127.0.0.1:27901', UNAGENT_CONNECT_RUN_ID: 'r1', UNAGENT_CONNECT_EXECUTION_TOKEN: 'fixture-execution', UNAGENT_CONNECT_TOKEN: 'fixture-recipient' } };
  let submission;
  const a = unagent({ call: async (...args) => {
    if (args[1] === 'connect.submit') { submission = args; return { task: { id: 'hub-task' } }; }
    return mock.call(...args);
  } });
  assert.equal((await a.execute(f.ctx)).text, 'native final');
  assert.equal(submission[2].idempotencyKey, submission[3]);
  assert.deepEqual(submission[2].hub, { url: 'http://127.0.0.1:27901', runId: 'r1', executionToken: 'fixture-execution' });
  assert.equal(submission[2].content, 'do scoped work');
  assert.equal(JSON.stringify(submission[2]).includes('fixture-recipient'), false);
  assert.equal(JSON.stringify(f.history).includes('fixture-execution'), false);
  assert.equal(JSON.stringify(f.events).includes('fixture-execution'), false);
  assert.equal(f.events.find(e => e.type === 'capability').data.automaticHandoff, true);
  assert.equal(mock.calls.some(c => c.op === 'sessions.send'), false);
});
test('UNagent hubAware METHOD_NOT_FOUND clearly requires setup and never silently falls back', async () => {
  const f = context({ ...uaConfig, hubAware: true }), mock = uaMock(f); let sends = 0;
  f.ctx.mcpConfig = { env: { UNAGENT_CONNECT_URL: 'http://127.0.0.1:27901', UNAGENT_CONNECT_EXECUTION_TOKEN: 'fixture' } };
  const a = unagent({ call: (...args) => {
    if (args[1] === 'connect.submit') throw Object.assign(new Error('missing native method'), { code: 'METHOD_NOT_FOUND' });
    if (args[1] === 'sessions.send') sends++;
    return mock.call(...args);
  } });
  await assert.rejects(a.execute(f.ctx), e => e.code === 'NEEDS_SETUP' && /METHOD_NOT_FOUND/.test(e.message));
  assert.equal(sends, 0);
});
test('UNagent unknown send has no task receipt and never retries delivery or session creation', async () => {
  const f = context(uaConfig), mock = uaMock(f);
  const a = unagent({ call: (...args) => args[1] === 'sessions.send' ? Promise.reject(new Error('lost receipt')) : mock.call(...args) });
  await assert.rejects(a.execute(f.ctx), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(a.execute(f.ctx), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(mock.calls.filter(c => c.op === 'sessions.create').length, 1);
});
test('UNagent rejects foreign project scope, busy existing sessions and wrong catalog model', async () => {
  for (const scenario of ['foreign', 'busy', 'model']) {
    const f = context({ ...uaConfig, ...(scenario === 'model' ? { modelId: 'invented' } : { sessionId: 's1' }) });
    let sent = false;
    const a = unagent({ call: async (_, op) => {
      if (op === 'models.list') return [{ id: 'catalog-model' }];
      if (op === 'sessions.list') return [{ id: 's1', purpose: scenario === 'foreign' ? 'another project' : `unagent-connect:${hash('p1', workspace)}`, running: scenario === 'busy', queued: 0 }];
      sent = true; throw new Error('must not send');
    } });
    await assert.rejects(a.execute(f.ctx)); assert.equal(sent, false);
  }
});
test('cancel unblocks outstanding UNagent question and needs terminal evidence', async () => {
  const f = context(uaConfig); let cancelled = false, questionStarted;
  const started = new Promise(resolve => { questionStarted = resolve; });
  f.ctx.ask = () => { questionStarted(); return new Promise(() => {}); };
  const mock = uaMock(f, p => ({ id: p.taskId, status: cancelled ? 'cancelled' : 'waiting_origin', question: { questionId: 'q', text: 'pending' } }));
  const a = unagent({ call: async (...args) => { if (args[1] === 'tasks.cancel') cancelled = true; return mock.call(...args); } });
  const execution = a.execute(f.ctx); const rejection = assert.rejects(execution, { code: 'OUTCOME_UNKNOWN' });
  await started; assert.deepEqual(await a.cancel(f.ctx), { stopped: true }); await rejection;
});

const hConfig = { gatewayDir: '/existing-gateway', hostId: 'host1' };
function harnessMock(f, overrides = {}) {
  const calls = []; let n = 0;
  const call = async (c, op, p) => {
    calls.push({ op, p });
    if (overrides[op]) return overrides[op](p);
    if (op === 'health') return { hostId: 'host1', protocolVersion: 1, version: '0.2.0-rc.2', nativePersistence: true };
    if (op === 'create' || op === 'session') return { sessionId: 'hs1', workspace, busy: false };
    if (op === 'prompt') {
      assert.equal(f.ctx.run.nativeBinding.requestId, p.requestId);
      return { requestId: p.requestId, turnId: `turn-${++n}`, accepted: true };
    }
    if (op === 'events') return { cursor: 2, events: [{ seq: 2, requestId: p.requestId, turnId: f.ctx.run.nativeBinding.turnId ?? 'turn-1', type: 'completed', text: 'Harness final' }] };
    if (op === 'cancel') return { requested: true };
    throw new Error(`Unexpected ${op}`);
  };
  return { call, calls };
}
test('Harness binds host/session/request/turn and reuses session on second round', async () => {
  const f = context(hConfig, 'harness'), m = harnessMock(f); const a = harness({ call: m.call });
  assert.equal((await a.execute(f.ctx)).text, 'Harness final');
  const old = f.ctx.run.nativeBinding.requestId; f.ctx.run.attemptId = 'a2';
  await a.execute(f.ctx); assert.notEqual(f.ctx.run.nativeBinding.requestId, old);
  assert.equal(m.calls.filter(c => c.op === 'create').length, 1);
  assert.equal(m.calls.filter(c => c.op === 'prompt').length, 2);
});
test('Harness rejects incompatible version before creating or prompting', async () => {
  const f = context(hConfig, 'harness'), m = harnessMock(f, { health: () => ({ hostId: 'host1', protocolVersion: 1, version: 'old' }) });
  await assert.rejects(harness({ call: m.call }).execute(f.ctx), { code: 'INCOMPATIBLE' });
  assert.equal(m.calls.length, 1);
});
test('Harness unknown admission recovery only reads the original request', async () => {
  const f = context(hConfig, 'harness'), m = harnessMock(f, { prompt: () => { throw new Error('receipt lost'); } });
  const a = harness({ call: m.call }); await assert.rejects(a.execute(f.ctx), { code: 'OUTCOME_UNKNOWN' });
  assert.equal((await a.recover(f.ctx)).text, 'Harness final');
  assert.equal(m.calls.filter(c => c.op === 'prompt').length, 1);
});
test('Harness wrong request/turn events cannot complete a run', async () => {
  for (const field of ['requestId', 'turnId']) {
    const f = context(hConfig, 'harness'), m = harnessMock(f, { events: p => ({ cursor: 1, events: [{ seq: 1, requestId: p.requestId, turnId: 'turn-1', [field]: 'foreign', type: 'completed', text: 'wrong' }] }) });
    await assert.rejects(harness({ call: m.call }).execute(f.ctx), { code: 'OUTCOME_UNKNOWN' });
  }
});
test('Harness native question is handled in the app, not invented answer RPC', async () => {
  const f = context(hConfig, 'harness'); let answered = false;
  const m = harnessMock(f, { events: p => ({ cursor: answered ? 2 : 1, events: [{ seq: answered ? 2 : 1, requestId: p.requestId, turnId: 'turn-1', type: answered ? 'completed' : 'waiting_input', text: answered ? 'after UI answer' : 'native input' }] }) });
  f.ctx.ask = async q => { assert.equal(q.kind, 'approval'); answered = true; return { approved: true }; };
  assert.equal((await harness({ call: m.call, pollMs: 0 }).execute(f.ctx)).text, 'after UI answer');
  assert.equal(m.calls.some(c => c.op === 'answer'), false);
});
test('Harness cancel ignores accepted stop request without terminal event', async () => {
  const f = context(hConfig, 'harness'); let terminal = false;
  Object.assign(f.ctx.run, { nativeBinding: { provider: 'harness', participantId: 'p1', workspace, hostId: 'host1', gatewayDir: hConfig.gatewayDir, sessionId: 'hs1', attemptId: 'a1', requestId: 'request', turnId: 'turn' } });
  const m = harnessMock(f, { events: () => ({ cursor: 0, events: terminal ? [{ requestId: 'request', turnId: 'turn', type: 'cancelled' }] : [] }) });
  const a = harness({ call: m.call }); assert.deepEqual(await a.cancel(f.ctx), { stopped: false }); terminal = true;
  assert.deepEqual(await a.cancel(f.ctx), { stopped: true });
});

const wConfig = { gatewayDir: '/existing-gateway' };
function workbuddyMock(f, overrides = {}) {
  const calls = []; let task;
  const call = async (_, op, p) => {
    calls.push({ op, p }); if (overrides[op]) return overrides[op](p, task);
    if (op === 'workbuddy_health') return { backend: 'desktop-queue', online: true, persistentService: { installed: true } };
    if (op === 'workbuddy_list_workspaces') return { workers: [{ sessionId: 'ws1', workspace, desktopRegistered: true }] };
    if (op === 'native_create') return { sessionId: p.sessionId, workspace };
    if (op === 'native_session') return { state: 'idle', workspace };
    if (op === 'workbuddy_send_task') { assert.equal(f.ctx.run.nativeBinding.taskId, p.taskId); task = { taskId: p.taskId, sessionId: p.sessionId, attemptId: `run-${p.taskId}`, state: 'needs_review', runtimeSource: 'desktop_queue', report: { rawText: 'real native report' } }; return { ok: true, task }; }
    if (op === 'workbuddy_get_task') return { task, messages: [] };
    if (op === 'native_snapshot') return { taskId: task.taskId, attemptId: task.attemptId, sessionId: task.sessionId, status: 'needs_review', stopReason: 'end_turn', runtimeSource: 'desktop_queue', text: 'real native report' };
    if (op === 'native_cancel') return { requested: true };
    throw new Error(`Unexpected ${op}`);
  };
  return { call, calls };
}
test('WorkBuddy creates a dedicated native session and reuses it across rounds', async () => {
  const f = context(wConfig, 'workbuddy'), m = workbuddyMock(f); const a = workbuddy({ call: m.call });
  const first = await a.execute(f.ctx); assert.equal(first.nativeBinding.runtimeSource, 'desktop_queue');
  f.ctx.run.attemptId = 'a2'; f.ctx.run.content = 'real second-round feedback';
  // Previously created session is visible in the native worker catalog on the next round.
  const call = async (...args) => args[1] === 'workbuddy_list_workspaces' ? { workers: [{ sessionId: first.nativeSessionId, workspace, desktopRegistered: true }] } : m.call(...args);
  assert.equal((await workbuddy({ call }).execute(f.ctx)).nativeSessionId, first.nativeSessionId);
  assert.equal(m.calls.filter(c => c.op === 'native_create').length, 1);
  assert.equal(m.calls.filter(c => c.op === 'workbuddy_send_task').length, 2);
});
test('WorkBuddy needs both real runtime source and native terminal evidence', async () => {
  for (const scenario of ['source', 'stop']) {
    const f = context(wConfig, 'workbuddy');
    const m = workbuddyMock(f, { workbuddy_get_task: (_, task) => ({ task: { ...task, state: 'blocked', runtimeSource: scenario === 'source' ? 'hidden-cli' : 'desktop_queue' }, messages: [] }),
      native_snapshot: (_, task) => ({ taskId: task.taskId, attemptId: task.attemptId, sessionId: task.sessionId, status: 'blocked', ...(scenario === 'source' ? { stopReason: 'end_turn' } : {}) }) });
    await assert.rejects(workbuddy({ call: m.call }).execute(f.ctx), { code: 'OUTCOME_UNKNOWN' });
  }
});
test('WorkBuddy refusal to install/migrate service or use busy/wrong-project sessions', async () => {
  for (const mode of ['no-service', 'busy', 'wrong-project']) {
    const f = context({ ...wConfig, sessionId: 'ws1' }, 'workbuddy');
    const m = workbuddyMock(f, { workbuddy_health: () => ({ backend: 'desktop-queue', online: true, persistentService: { installed: mode !== 'no-service' } }),
      native_session: () => ({ state: mode === 'busy' ? 'busy' : 'idle', workspace: mode === 'wrong-project' ? '/' : workspace }) });
    await assert.rejects(workbuddy({ call: m.call }).execute(f.ctx));
    assert.equal(m.calls.some(c => c.op === 'workbuddy_send_task'), false);
  }
});
test('WorkBuddy disconnected readback recovers by task ID and never sends a second native prompt', async () => {
  const f = context(wConfig, 'workbuddy'); let offline = true;
  const m = workbuddyMock(f, { workbuddy_get_task: (_, task) => { if (offline) throw new Error('offline'); return { task, messages: [] }; } });
  const a = workbuddy({ call: m.call }); await assert.rejects(a.execute(f.ctx), { code: 'OUTCOME_UNKNOWN' });
  offline = false; assert.equal((await a.recover(f.ctx)).text, 'real native report');
  assert.equal(m.calls.filter(c => c.op === 'workbuddy_send_task').length, 1);
});
test('WorkBuddy ACP clarification and approval use native input channel with authorized answer only', async () => {
  for (const approval of [true, false]) {
    const f = context({ ...wConfig, sessionId: 'ws1' }, 'workbuddy'); let answered = false;
    const m = workbuddyMock(f, {
      workbuddy_health: () => ({ backend: 'desktop-acp', online: true, sessions: [{ sessionId: 'ws1', workspace, ready: true }] }),
      workbuddy_get_task: (_, task) => ({ task: { ...task, state: answered ? 'needs_review' : 'blocked', runtimeSource: 'desktop_interactive' }, messages: answered ? [] : [{ message_id: 'input-exact', metadata: { type: 'input_request', attemptId: task.attemptId, input: { method: approval ? 'session/request_permission' : 'elicitation/create', options: [{ kind: 'allow_once', optionId: 'one' }] } } }] }),
      native_snapshot: (_, t) => ({ taskId: t.taskId, attemptId: t.attemptId, sessionId: t.sessionId, status: answered ? 'needs_review' : 'working', waitingInput: !answered, ...(answered ? { stopReason: 'end_turn', runtimeSource: 'desktop_interactive' } : {}) }),
      workbuddy_respond_task: p => { assert.equal(p.decision, approval ? 'allow_once' : 'submit'); if (!approval) assert.deepEqual(p.content, { folder: 'A' }); answered = true; return { ok: true }; },
    });
    f.ctx.ask = async q => { assert.equal(q.nativeRequestId, 'input-exact'); assert.equal(q.kind, approval ? 'approval' : 'clarification'); return approval ? { approved: true } : { answer: '{"folder":"A"}' }; };
    assert.equal((await workbuddy({ call: m.call, pollMs: 0 }).execute(f.ctx)).text, 'real native report');
    assert.equal(m.calls.filter(c => c.op === 'workbuddy_respond_task').length, 1);
  }
});
test('WorkBuddy native cancel request without final stop remains stopped:false', async () => {
  const f = context(wConfig, 'workbuddy'); let ended = true;
  const m = workbuddyMock(f, { native_snapshot: (_, t) => ({ taskId: t.taskId, attemptId: t.attemptId, sessionId: t.sessionId, status: ended ? 'cancelled' : 'working', ...(ended ? { stopReason: 'cancelled' } : {}) }) });
  // Obtain a genuine persisted binding through normal execution first.
  m.call = m.call.bind(m); const original = m.call;
  const a = workbuddy({ call: async (...args) => args[1] === 'native_snapshot' && !f.ctx.run.nativeBinding?.terminal
    ? { taskId: f.ctx.run.nativeBinding.taskId, sessionId: f.ctx.run.nativeBinding.sessionId, attemptId: f.ctx.run.nativeBinding.nativeAttemptId, status: 'needs_review', stopReason: 'end_turn', runtimeSource: 'desktop_queue' } : original(...args) });
  await a.execute(f.ctx); ended = false;
  assert.deepEqual(await a.cancel(f.ctx), { stopped: false }); ended = true;
  assert.deepEqual(await a.cancel(f.ctx), { stopped: true });
});
test('all native adapters declare connector dependency and MCP auto-handoff limitation', async () => {
  for (const create of [unagent, harness, workbuddy]) {
    const a = create(); assert.equal(a.capabilities.manualMessaging, true); assert.equal(a.capabilities.requiresConnector, true);
    assert.equal(a.capabilities.automaticHandoff, false); assert.equal(a.capabilities.contextRead, false);
    assert.equal(typeof a.capabilities.connectorPackage, 'string');
    assert.equal((await a.health({})).state, 'needs_setup');
  }
  const f = context(uaConfig), m = uaMock(f); f.ctx.mcpConfig = { command: 'never-run-this', args: [] };
  await unagent({ call: m.call }).execute(f.ctx); assert.equal(f.events[0].data.automaticHandoff, false);
});
test('helper runs runtime client under original gateway launcher/config, without starting its server', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-gateway-fixture-'));
  try {
    await mkdir(path.join(dir, 'bin')); await mkdir(path.join(dir, 'dist'));
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(dir, 'bin/workbuddy-gateway'), '#!/bin/sh\nexport FIXTURE_GATEWAY_OWNS_CONFIG=yes\nexec "' + process.execPath + '" "$PWD/dist/server.js"\n');
    await chmod(path.join(dir, 'bin/workbuddy-gateway'), 0o700);
    await writeFile(path.join(dir, 'dist/server.js'), 'throw new Error("MCP server must not start for native helper")');
    await writeFile(path.join(dir, 'dist/config.js'), 'export function loadConfig(){if(process.env.FIXTURE_GATEWAY_OWNS_CONFIG!=="yes")throw Error("wrong launcher");return {}}');
    await writeFile(path.join(dir, 'dist/workbuddy-client.js'), 'export class WorkBuddyClient { runSnapshot(id){return {attemptId:id,status:"working"}} }');
    assert.deepEqual(await gatewayCall('workbuddy', { gatewayDir: dir }, 'native_snapshot', { attemptId: 'exact-attempt' }), { attemptId: 'exact-attempt', status: 'working' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('bridge helper uses original versioned CLI, explicit identity, stdin and completed receipt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-fixture-'));
  try {
    await mkdir(path.join(dir, 'scripts')); await writeFile(path.join(dir, 'VERSION'), '0.1.1\n');
    await writeFile(path.join(dir, 'scripts/unagent-connect.mjs'), `let raw='';for await(const c of process.stdin)raw+=c;console.log(JSON.stringify({status:'completed',result:{args:process.argv.slice(2),params:JSON.parse(raw)}}));`);
    const result = await bridgeCall({ ...uaConfig, bridgeDir: dir }, 'tasks.get', { taskId: 'saved' }, 'stable');
    assert.deepEqual(result.params, { taskId: 'saved' }); assert.ok(result.args.includes('instance')); assert.ok(result.args.includes('paired'));
    for (const version of ['0.2.0', '0.2.7']) {
      await writeFile(path.join(dir, 'VERSION'), version);
      assert.deepEqual((await bridgeCall({ ...uaConfig, bridgeDir: dir }, 'tasks.get', {}, 'stable')).params, {});
    }
    await writeFile(path.join(dir, 'VERSION'), '0.3.0');
    await assert.rejects(bridgeCall({ ...uaConfig, bridgeDir: dir }, 'tasks.get', {}, 'stable'), { code: 'INCOMPATIBLE' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('helper does not echo native private error envelopes', async () => {
  await assert.rejects(jsonProcess(process.execPath, ['-e', 'console.log(JSON.stringify({error:{code:"PRIVATE_FAILURE",message:"dummy-secret-must-not-escape"}}));process.exit(1)']), e => e.code === 'PRIVATE_FAILURE' && !e.message.includes('dummy-secret'));
});
test('real legacy CLI/daemon forwards connect.submit, enforces matching business key and reuses receipt', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'connect-submit-fixture-'));
  const home = path.join(dir, 'bridge'); const bridge = createBridgeServer({ home, port: 0 });
  try {
    const { port } = await bridge.listen(), base = `http://127.0.0.1:${port}`;
    const nativeSession = randomUUID().replaceAll('-', ''); let hostToken;
    const request = async (route, token, body) => {
      const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(token === hostToken && token ? { 'X-UNagent-Bridge-Session': nativeSession } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, value: res.status === 204 ? null : await res.json() };
    };
    const code = await request('/v1/admin/pair-codes', bridge.adminToken, { purpose: 'host' });
    const host = (await request('/v1/hosts/pair', null, { code: code.value.code, name: 'synthetic host', registrationId: randomUUID() })).value;
    hostToken = host.instanceToken;
    const clientCode = await request(`/v1/instances/${host.instanceId}/pair-codes`, hostToken, { purpose: 'client' });
    const profile = 'hub-test';
    const client = (await request('/v1/clients/register', null, { code: clientCode.value.code, name: profile, registrationId: randomUUID() })).value;
    await writeFile(path.join(home, 'bridge-config.json'), JSON.stringify({ address: base }), { mode: 0o600 });
    await mkdir(path.join(home, 'clients'), { recursive: true });
    const suffix = createHash('sha256').update(profile).digest('hex').slice(0, 8);
    await writeFile(path.join(home, 'clients', `${profile}-${suffix}.json`), JSON.stringify({ ...client, name: profile, instanceId: host.instanceId }), { mode: 0o600 });
    const params = { sessionId: 'plugin-session', content: 'synthetic work', hub: { url: base, runId: 'parent', executionToken: 'fixture-token' } };
    const cli = fileURLToPath(new URL('../scripts/unagent-connect.mjs', import.meta.url));
    const run = (idem, p) => jsonProcess(process.execPath, [cli, 'call', 'connect.submit', '--instance', host.instanceId, '--client', profile, '--idem', idem, '--params-file', '-', '--timeout-ms', '3000'],
      { env: { ...process.env, NODE_ENV: 'test', UNAGENT_BRIDGE_TEST_HOME: home }, input: p, timeoutMs: 5000 });
    const deliveryPromise = request(`/v1/instances/${host.instanceId}/next?waitMs=3000`, hostToken);
    const execution = run('logical-send', params);
    const delivery = (await deliveryPromise).value;
    assert.equal(delivery.method, 'connect.submit'); assert.equal(delivery.params.idempotencyKey, 'logical-send');
    assert.deepEqual(delivery.params.hub, params.hub);
    await request(`/v1/instances/${host.instanceId}/ack`, hostToken, { callId: delivery.callId, ok: true, result: { task: { id: 'native-task' } } });
    const receipt = await execution;
    assert.equal(receipt.result.task.id, 'native-task');
    assert.equal((await run('logical-send', params)).callId, receipt.callId);
    await assert.rejects(run('outer', { ...params, idempotencyKey: 'inner' }), { code: 'IDEMPOTENCY_CONFLICT' });
    const invalid = await request('/v1/calls', client.clientToken, { instanceId: host.instanceId, method: 'connect.submit', params: { ...params, idempotencyKey: 'wrong' }, idempotencyKey: 'right' });
    assert.equal(invalid.status, 400); assert.equal(invalid.value.error.code, 'BAD_REQUEST');
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});
