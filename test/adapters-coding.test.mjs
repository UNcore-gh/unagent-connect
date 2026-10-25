import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAdapter as codex } from '../src/adapters/codex.mjs';
import { createAdapter as claude } from '../src/adapters/claude.mjs';
import { NativeRpc, deferred, LIMIT, hubToolNames } from '../src/adapters/coding-native.mjs';

const cwd = process.cwd();
function context(extra = {}) {
  const controller = new AbortController(), saved = [], events = [], questions = [];
  return { run: { id: 'run-1', attemptId: 'attempt-1', threadId: 'hub-thread', round: 1,
    content: 'Read-only tiny prompt', workspace: cwd },
  participant: { id: 'worker-1', workspace: cwd, config: {} },
  signal: controller.signal, controller, saved, events, questions,
  saveBinding: async value => { saved.push(structuredClone(value)); },
  emit: event => { events.push(event); },
  ask: async q => { questions.push(q); return { approved: true, answer: 'Accept' }; },
  mcpConfig: { command: 'node', args: ['hub.mjs', 'mcp'], env: { UNAGENT_ATTEMPT_TOKEN: 'never-print-this-token' } },
  ...extra };
}

// A real stdio child, not an RPC object mock: exercises framing, interleaved
// notifications/requests, early terminal events and transport death.
const nativeFixture = String.raw`
import readline from 'node:readline';
const mode = process.env.FIXTURE_MODE;
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
let thread = 'native-thread', turn = 'native-turn', answered = 0;
const notify = (method, params) => send({method, params:{threadId:thread, turnId:turn, ...params}});
function finish(status='completed') {
  notify('item/completed', {item:{type:'agentMessage',id:'answer',text:'native answer'}});
  notify('turn/completed', {turn:{id:turn,status}});
}
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line), ok = result => send({id:m.id,result});
 if (!m.method) {
   if (m.id===900 || m.id===901) {
     if(mode==='parallel-approval' && ++answered<2) return;
     if (mode==='approval-deny' && m.result?.decision!=='decline') process.exit(7);
     if (mode==='approval' && m.result?.decision!=='accept') process.exit(8);
     if (mode==='permissions' && !m.result?.permissions?.network?.enabled) process.exit(9);
     if (mode==='foreign-approval' && !m.error) process.exit(10);
     if (mode==='user-input' && m.result?.answers?.q?.answers?.[0]!=='Accept') process.exit(11);
     finish();
   }
   return;
 }
 if(m.method==='initialize') return ok({userAgent:'fixture'});
 if(m.method==='thread/read') return ok({thread:{id:m.params.threadId,cwd:process.env.FIXTURE_CWD,
   status:{type:mode==='busy'?'active':mode==='not-loaded'?'notLoaded':'idle'}}});
 if(m.method==='thread/start'||m.method==='thread/resume') {
   if(process.env.FIXTURE_BAD_MCP_KEY==='true'||mode==='invalid-mcp-name') return send({id:m.id,error:{code:-32603,
     message:'error creating thread: required MCP server name contains literal quotes'}});
   if(m.params.approvalPolicy!=='on-request'||m.params.approvalsReviewer!=='user') process.exit(12);
   thread=m.params.threadId||(mode==='new-session'?'different-thread':thread);
   return ok({thread:{id:thread,cwd:m.params.cwd,status:{type:'idle'}}});
 }
 if(m.method==='turn/start') {
   if(mode==='reject') return send({id:m.id,error:{code:-32602,message:'rejected'}});
   if(mode==='early') {finish(); return ok({turn:{id:turn,status:'inProgress'}});}
   ok({turn:{id:turn,status:'inProgress'}});
   if(mode==='parallel-approval') {
     for(const n of [900,901]) send({id:n,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,command:'echo safe'}});
     return;
   }
   if(mode==='disconnect') return process.exit(0);
   if(mode==='malformed') return process.stdout.write('{bad\n');
   if(mode==='oversized') return process.stdout.write('x'.repeat(2*1024*1024+10));
   if(mode==='wait'||mode==='ack-only'||mode==='delay-start') return;
   if(mode==='approval'||mode==='approval-deny'||mode==='permissions'||mode==='foreign-approval'||mode==='user-input') {
     const method = mode==='permissions'?'item/permissions/requestApproval':mode==='user-input'?'item/tool/requestUserInput':'item/commandExecution/requestApproval';
     return send({id:900,method,params:{threadId:mode==='foreign-approval'?'other-thread':thread,turnId:turn,
       command:'touch example.txt',cwd:process.env.FIXTURE_CWD,permissions:{network:{enabled:true}},
       questions:[{id:'q',question:'Continue?',options:[{label:'Accept'},{label:'Decline'}]}]}});
   }
   if(mode==='foreign-turn') {
     notify('turn/completed',{threadId:'other-thread',turn:{id:turn,status:'completed'}});
     return setTimeout(()=>finish('failed'),5);
   }
   if(mode==='failed') return finish('failed');
   return setImmediate(()=>finish());
 }
 if(m.method==='turn/interrupt') {ok({}); if(mode!=='ack-only') finish('interrupted'); return;}
 if(m.id!=null) send({id:m.id,error:{code:-32601,message:'unknown'}});
});
`;
function codexHarness(mode = 'success', overrides = {}) {
  const launches = [];
  return { launches, adapter: codex({ rpcTimeoutMs: 1000, stopTimeoutMs: 80, maxRunMs: 3000,
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return spawn(process.execPath, ['--input-type=module', '-e', nativeFixture], {
        ...options, env: { ...options.env, FIXTURE_MODE: Array.isArray(mode) ? mode[launches.length - 1] : mode, FIXTURE_CWD: overrides.nativeCwd ?? cwd,
          FIXTURE_BAD_MCP_KEY: String(args.some(arg => arg.startsWith('mcp_servers."'))) },
      });
    }, ...overrides }) };
}
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for fixture'); await new Promise(r => setTimeout(r, 2)); }
}

test('Codex real NDJSON handshake, dedicated binding, scoped MCP and exact rework resume', async () => {
  const { adapter, launches } = codexHarness();
  const ctx = context();
  const first = await adapter.execute(ctx);
  assert.equal(first.text, 'native answer');
  assert.equal(ctx.saved.length, 2);
  assert.equal(first.nativeBinding.workspace, cwd);
  assert.equal(first.nativeBinding.dedicated, true);
  assert.equal(ctx.events[0].text, 'native answer');
  const spec = launches[0];
  assert.equal(spec.options.shell, false);
  assert(spec.args.includes('stdio://'));
  assert(spec.args.join(' ').includes('unagent-connect'));
  assert(spec.args.join(' ').includes('"enabled_tools"='));
  assert(spec.args.join(' ').includes('"default_tools_approval_mode"="approve"'));
  assert(spec.args.join(' ').includes('connect_runs_submit'));
  assert(!spec.args.join(' ').includes('connect_admin_'));
  assert(!spec.args.join(' ').includes('never-print-this-token'));
  assert.equal(spec.options.env.UNAGENT_ATTEMPT_TOKEN, 'never-print-this-token');
  ctx.run = { ...ctx.run, ...ctx.saved.at(-1), content: 'Rework this answer', round: 2, attemptId: 'attempt-2' };
  assert.equal((await adapter.execute(ctx)).nativeSessionId, first.nativeSessionId);
});

test('Codex terminal-before-turn-start-response is retained', async () => {
  assert.equal((await codexHarness('early').adapter.execute(context())).text, 'native answer');
});

test('Codex literal-quoted MCP name reproduces native -32603 and corrected dotted key is unquoted', async () => {
  await assert.rejects(codexHarness('invalid-mcp-name').adapter.execute(context()),
    { code: 'NATIVE_REJECTED', nativeCode: -32603, rpcMethod: 'thread/start' });
  const h = codexHarness();
  await h.adapter.execute(context());
  const override = h.launches[0].args.find(arg => arg.startsWith('mcp_servers.'));
  assert(override.startsWith('mcp_servers.unagent-connect='));
  assert(!override.startsWith('mcp_servers."'));
});

for (const mode of ['approval', 'approval-deny', 'permissions', 'user-input']) {
  test(`Codex admin approval path: ${mode}`, async () => {
    const ctx = context();
    ctx.ask = async q => { ctx.questions.push(q); return { approved: mode !== 'approval-deny', answer: 'Accept' }; };
    await codexHarness(mode).adapter.execute(ctx);
    assert.equal(ctx.questions.length, 1);
    assert.equal(ctx.questions[0].kind, 'approval');
    assert.equal(ctx.questions[0].nativeRequestId, '900');
  });
}

test('Codex foreign native approval is rejected without asking Hub', async () => {
  const ctx = context();
  await codexHarness('foreign-approval').adapter.execute(ctx);
  assert.equal(ctx.questions.length, 0);
});

test('Codex foreign terminal does not complete this run', async () => {
  await assert.rejects(codexHarness('foreign-turn').adapter.execute(context()), { code: 'NATIVE_FAILED' });
});

test('Codex refusal is explicit; transport loss/malformed/oversized streams are unknown and never retried', async () => {
  await assert.rejects(codexHarness('reject').adapter.execute(context()), { code: 'NATIVE_REJECTED' });
  for (const mode of ['disconnect', 'malformed', 'oversized']) {
    const { adapter, launches } = codexHarness(mode), ctx = context();
    await assert.rejects(adapter.execute(ctx), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(launches.length, 1);
    await assert.rejects(adapter.execute(ctx), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(launches.length, 1);
  }
});

test('Codex admin confirmation releases only the exact uncertain attempt and permits same-session resume', async () => {
  const { adapter, launches } = codexHarness(['disconnect', 'new-session']), ctx = context();
  await assert.rejects(adapter.execute(ctx), { code: 'OUTCOME_UNKNOWN' });
  const original = { ...ctx.run, ...ctx.saved.at(-1) };
  const foreign = { ...ctx.participant, id: 'another-worker' };
  assert.deepEqual(adapter.confirmStopped({ run: original, participant: foreign, confirmedStopped: true }), { released: false });
  await assert.rejects(adapter.execute({ ...ctx, run: { ...original, attemptId: 'attempt-foreign' } }), { code: 'OUTCOME_UNKNOWN' });
  assert.throws(() => adapter.confirmStopped({ run: original, participant: ctx.participant }), { code: 'CONFIRM_REQUIRED' });
  assert.throws(() => adapter.confirmStopped({ run: { ...original, attemptId: 'attempt-foreign' }, participant: ctx.participant, confirmedStopped: true }),
    { code: 'BINDING_UNVERIFIED' });
  assert.equal(launches.length, 1);

  assert.deepEqual(adapter.confirmStopped({ run: original, participant: ctx.participant, confirmedStopped: true }), { released: true });
  ctx.run = { ...original, attemptId: 'attempt-2', round: 2 };
  const result = await adapter.execute(ctx);
  assert.equal(result.nativeSessionId, original.nativeSessionId);
  assert.equal(launches.length, 2);
});

test('Codex existing session must have matching workspace and positive idle evidence', async () => {
  for (const mode of ['busy', 'not-loaded']) {
    const ctx = context(); ctx.run.nativeSessionId = 'user-session';
    await assert.rejects(codexHarness(mode).adapter.execute(ctx), { code: 'SESSION_BUSY' });
  }
  const ctx = context(); ctx.run.nativeSessionId = 'user-session';
  await assert.rejects(codexHarness('success', { nativeCwd: '/tmp' }).adapter.execute(ctx), { code: 'WORKSPACE_MISMATCH' });
  assert.equal(ctx.saved.length, 0);
  const wrong = context(); wrong.run.nativeSessionId = 'user-session';
  wrong.run.nativeBinding = { adapter: 'codex', participantId: 'another-worker', workspace: cwd,
    nativeSessionId: 'user-session', dedicated: true };
  await assert.rejects(codexHarness().adapter.execute(wrong), { code: 'BINDING_UNVERIFIED' });
});

test('Codex concurrent native approvals are queued for the single Hub question slot', async () => {
  const { adapter } = codexHarness('parallel-approval'), ctx = context();
  let open = 0, maximum = 0;
  ctx.ask = async q => {
    ctx.questions.push(q); maximum = Math.max(maximum, ++open);
    await new Promise(resolve => setTimeout(resolve, 5)); open--;
    return { approved: true };
  };
  await adapter.execute(ctx);
  assert.equal(ctx.questions.length, 2); assert.equal(maximum, 1);
});

test('Codex failure to persist turn identity after admission is unknown, not a retry', async () => {
  const { adapter, launches } = codexHarness('wait'), ctx = context();
  ctx.saveBinding = async value => { ctx.saved.push(value); if (ctx.saved.length === 2) throw new Error('disk unavailable'); };
  await assert.rejects(adapter.execute(ctx), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(launches.length, 1);
});

test('Codex signal interrupt waits for matching terminal; ACK alone is insufficient', async () => {
  for (const mode of ['wait', 'ack-only']) {
    const { adapter } = codexHarness(mode), ctx = context();
    const execution = adapter.execute(ctx);
    const check = assert.rejects(execution, { code: mode === 'wait' ? 'CANCELLED' : 'OUTCOME_UNKNOWN' });
    await until(() => ctx.saved.length === 2);
    const stale = { ...ctx, run: { ...ctx.run, attemptId: 'old-attempt' } };
    assert.deepEqual(await adapter.cancel(stale), { stopped: false });
    ctx.controller.abort();
    const evidence = await adapter.cancel(ctx);
    assert.equal(evidence.stopped, mode === 'wait');
    await check;
  }
});

test('Codex cancellation unwinds pending approval without allowing a late answer', async () => {
  const { adapter } = codexHarness('approval'), ctx = context(), answer = deferred();
  ctx.ask = q => { ctx.questions.push(q); return answer.promise; };
  const check = assert.rejects(adapter.execute(ctx), { code: 'CANCELLED' });
  await until(() => ctx.questions.length === 1);
  ctx.controller.abort();
  answer.resolve({ approved: true });
  await check;
});

function sdkHarness(mode = 'success') {
  const calls = [], gate = deferred();
  let controls;
  const sdk = { query(args) {
    calls.push(args);
    const queryMode = Array.isArray(mode) ? mode[calls.length - 1] : mode;
    const sessionId = args.options.resume ?? args.options.sessionId;
    const result = extra => ({ type: 'result', subtype: 'success', is_error: false,
      result: 'sdk answer', session_id: sessionId, terminal_reason: 'completed', ...extra });
    const iterator = (async function* () {
      const user = await args.prompt.next();
      assert.equal(user.value.message.content, 'Read-only tiny prompt');
      yield { type: 'system', subtype: 'init', session_id: sessionId,
        mcp_servers: [{ name: 'unagent-connect', status: queryMode === 'mcp-failed' ? 'failed' : 'connected' }] };
      if (['approval', 'denial', 'question', 'pending'].includes(queryMode)) {
        const answer = await args.options.canUseTool(queryMode === 'question' ? 'AskUserQuestion' : 'Write',
          queryMode === 'question' ? { questions: [{ question: 'Which scope?' }] } : { file_path: 'example.txt', content: 'x' },
          { signal: new AbortController().signal, toolUseID: 'tool-1' });
        controls.permission = answer;
      }
      if (queryMode === 'parallel-approval') controls.permissions = await Promise.all([1,2].map(n => args.options.canUseTool('Write',
        { file_path: 'example-'+n+'.txt', content: 'x' }, { signal: new AbortController().signal, toolUseID:'tool-'+n })));
      if (['wait', 'ack-only', 'pending'].includes(queryMode)) await gate.promise;
      if (controls.interrupted && queryMode !== 'ack-only') { yield result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' }); return; }
      if (queryMode === 'no-result') return;
      if (queryMode === 'throw') throw new Error('native lost');
      if (queryMode === 'oversized') { yield { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'x'.repeat(LIMIT + 1) }] } }; return; }
      if (queryMode === 'wrong-session') { yield result({ session_id: 'unrelated-user-session' }); return; }
      if (queryMode === 'failed') { yield result({ subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' }); return; }
      if (queryMode === 'incomplete') { yield result({ terminal_reason: 'blocking_limit' }); return; }
      yield { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'thinking', thinking: 'never emit hidden reasoning' }, { type: 'text', text: 'public answer' }] } };
      yield result();
    })();
    controls = { permission: null, interrupted: false, closed: false,
      next: (...a) => iterator.next(...a),
      interrupt: async () => { controls.interrupted = true; if (queryMode !== 'ack-only') gate.resolve(); },
      close: () => { controls.closed = true; gate.resolve(); },
    };
    return controls;
  } };
  return { calls, get controls() { return controls; },
    adapter: claude({ loadSDK: async () => sdk, stopTimeoutMs: 50, maxRunMs: 2000 }) };
}

test('Claude streaming query persists dedicated ID before admission, resumes exact ID and attaches Hub MCP', async () => {
  const harness = sdkHarness(), ctx = context();
  const first = await harness.adapter.execute(ctx);
  const opts = harness.calls[0].options;
  assert.equal(opts.sessionId, first.nativeSessionId);
  assert.equal(opts.permissionMode, 'default');
  assert.equal(opts.allowDangerouslySkipPermissions, undefined);
  assert.equal(opts.continue, undefined);
  assert.deepEqual(opts.settingSources, ['user', 'project', 'local']);
  assert.equal(opts.systemPrompt.preset, 'claude_code');
  assert.equal(opts.mcpServers['unagent-connect'].env, undefined);
  assert(!JSON.stringify(opts.mcpServers).includes('never-print-this-token'));
  assert.equal(opts.env.UNAGENT_ATTEMPT_TOKEN, 'never-print-this-token');
  assert.equal(ctx.saved[0].nativeSessionId, first.nativeSessionId);
  assert.equal(ctx.events[0].text, 'public answer');
  assert(!JSON.stringify(ctx.events).includes('hidden reasoning'));
  assert(harness.controls.closed);
  ctx.run = { ...ctx.run, ...ctx.saved[0], attemptId: 'attempt-2', round: 2 };
  const second = await harness.adapter.execute(ctx);
  assert.equal(second.nativeSessionId, first.nativeSessionId);
  assert.equal(harness.calls[1].options.resume, first.nativeSessionId);
  assert.equal(harness.calls[1].options.sessionId, undefined);
});

for (const mode of ['approval', 'denial', 'question']) {
  test(`Claude native callback routes through Hub: ${mode}`, async () => {
    const h = sdkHarness(mode), ctx = context();
    ctx.ask = async q => { ctx.questions.push(q); return { approved: mode !== 'denial', answer: 'Project only' }; };
    await h.adapter.execute(ctx);
    assert.equal(ctx.questions[0].kind, mode === 'question' ? 'clarification' : 'approval');
    assert.equal(ctx.questions[0].nativeRequestId, 'tool-1');
    assert.equal(h.controls.permission.behavior, mode === 'denial' ? 'deny' : 'allow');
    assert.equal(h.controls.permission.updatedPermissions, undefined);
    if (mode === 'question') assert.equal(h.controls.permission.updatedInput.answers['Which scope?'], 'Project only');
  });
}

test('Claude refuses external/unverifiable session and participant/project mismatches', async () => {
  const h = sdkHarness(), ctx = context(); ctx.run.nativeSessionId = 'user-session';
  await assert.rejects(h.adapter.execute(ctx), { code: 'BINDING_UNVERIFIED' });
  assert.equal(h.calls.length, 0);
  const other = context(); other.participant = { ...other.participant, workspace: '/tmp' };
  await assert.rejects(h.adapter.execute(other), { code: 'WORKSPACE_MISMATCH' });
});

test('Claude explicit failures never succeed; missing/mismatched/oversized results remain unknown with no retry', async () => {
  for (const mode of ['failed', 'incomplete', 'no-result', 'throw', 'wrong-session', 'oversized']) {
    const h = sdkHarness(mode), ctx = context();
    const unknown = !['failed', 'incomplete'].includes(mode);
    await assert.rejects(h.adapter.execute(ctx), { code: unknown ? 'OUTCOME_UNKNOWN' : 'NATIVE_FAILED' });
    assert(h.controls.closed);
    if (unknown) {
      await assert.rejects(h.adapter.execute(ctx), { code: 'OUTCOME_UNKNOWN' });
      assert.equal(h.calls.length, 1);
    }
  }
});

test('Claude admin confirmation releases the exact uncertain turn and resumes its dedicated session', async () => {
  const h = sdkHarness(['throw', 'success']), ctx = context();
  await assert.rejects(h.adapter.execute(ctx), { code: 'OUTCOME_UNKNOWN' });
  const original = { ...ctx.run, ...ctx.saved[0] };
  assert.throws(() => h.adapter.confirmStopped({ run: original, participant: ctx.participant }), { code: 'CONFIRM_REQUIRED' });
  assert.throws(() => h.adapter.confirmStopped({ run: { ...original, attemptId: 'attempt-foreign' }, participant: ctx.participant, confirmedStopped: true }),
    { code: 'BINDING_UNVERIFIED' });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.adapter.confirmStopped({ run: original, participant: ctx.participant, confirmedStopped: true }), { released: true });
  ctx.run = { ...original, attemptId: 'attempt-2', round: 2 };
  const result = await h.adapter.execute(ctx);
  assert.equal(result.nativeSessionId, original.nativeSessionId);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.resume, original.nativeSessionId);
});

test('Claude failed scoped MCP cannot be reported as successful execution', async () => {
  const h = sdkHarness('mcp-failed');
  await assert.rejects(h.adapter.execute(context()), { code: 'MCP_UNAVAILABLE' });
  assert(h.controls.interrupted); assert(h.controls.closed);
});

test('Claude concurrent callbacks are queued for the single Hub question slot', async () => {
  const h = sdkHarness('parallel-approval'), ctx = context();
  let open = 0, maximum = 0;
  ctx.ask = async q => {
    ctx.questions.push(q); maximum = Math.max(maximum, ++open);
    await new Promise(resolve => setTimeout(resolve, 5)); open--;
    return { approved: true };
  };
  await h.adapter.execute(ctx);
  assert.equal(ctx.questions.length, 2); assert.equal(maximum, 1);
  assert(h.controls.permissions.every(x => x.behavior === 'allow'));
});

test('Claude only auto-allows exact frozen Hub tools from this attempt scoped MCP entry', async () => {
  const h = sdkHarness('wait'), ctx = context();
  ctx.ask = async q => { ctx.questions.push(q); return { approved: false }; };
  const check = assert.rejects(h.adapter.execute(ctx), { code: 'CANCELLED' });
  await until(() => h.calls.length > 0);
  const canUse = h.calls[0].options.canUseTool;
  for (const name of hubToolNames) {
    assert.equal((await canUse(`mcp__unagent-connect__${name}`, {}, {signal:ctx.signal})).behavior, 'allow');
  }
  assert.equal(ctx.questions.length, 0);
  const unsafe = ['mcp__other__connect_messages_send', 'mcp__unagent-connect__connect_admin_reset',
    'mcp__unagent-connect__connect_runs_submit_suffix', 'Write', 'Bash'];
  for (const name of unsafe) assert.equal((await canUse(name, {}, { signal:ctx.signal })).behavior, 'deny');
  assert.equal(ctx.questions.length, unsafe.length);
  assert(ctx.questions.every(q => q.kind === 'approval'));
  ctx.controller.abort(); await check;
});

test('Claude namespace spelling alone never authorizes a Hub tool without ctx.mcpConfig', async () => {
  const h = sdkHarness('wait'), ctx = context({ mcpConfig: undefined });
  ctx.ask = async q => { ctx.questions.push(q); return { approved: false }; };
  const check = assert.rejects(h.adapter.execute(ctx), { code: 'CANCELLED' });
  await until(() => h.calls.length > 0);
  const answer = await h.calls[0].options.canUseTool('mcp__unagent-connect__connect_messages_send', {}, { signal:ctx.signal });
  assert.equal(answer.behavior, 'deny'); assert.equal(ctx.questions[0].kind, 'approval');
  assert.equal(h.calls[0].options.mcpServers, undefined);
  ctx.controller.abort(); await check;
});

test('Adapter deadlines interrupt native execution without resubmitting', async () => {
  for (const h of [codexHarness('ack-only', { maxRunMs: 60 }), sdkHarness('ack-only')]) {
    const ctx = context(); ctx.run.deadlineAt = Date.now() + 80;
    await assert.rejects(h.adapter.execute(ctx), { code: 'OUTCOME_UNKNOWN' });
  }
});

test('Claude binding must be persisted before query is called', async () => {
  const h = sdkHarness(), ctx = context();
  ctx.saveBinding = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(h.adapter.execute(ctx), /disk unavailable/u);
  assert.equal(h.calls.length, 0);
});

test('Claude interrupt result proves termination, ACK alone remains unknown', async () => {
  for (const mode of ['wait', 'ack-only']) {
    const h = sdkHarness(mode), ctx = context();
    const check = assert.rejects(h.adapter.execute(ctx), { code: mode === 'wait' ? 'CANCELLED' : 'OUTCOME_UNKNOWN' });
    await until(() => h.calls.length > 0);
    assert.throws(() => h.adapter.confirmStopped({ run: { ...ctx.run, ...ctx.saved[0] }, participant: ctx.participant, confirmedStopped: true }),
      { code: 'SESSION_BUSY' });
    assert.deepEqual(await h.adapter.cancel({ ...ctx, run: { ...ctx.run, attemptId: 'stale' } }), { stopped: false });
    ctx.controller.abort();
    assert.equal((await h.adapter.cancel(ctx)).stopped, mode === 'wait');
    await check;
  }
});

test('Claude cancellation denies an outstanding permission callback and ignores late approval', async () => {
  const h = sdkHarness('pending'), ctx = context(), answer = deferred();
  ctx.ask = q => { ctx.questions.push(q); return answer.promise; };
  const check = assert.rejects(h.adapter.execute(ctx), { code: 'CANCELLED' });
  await until(() => ctx.questions.length > 0);
  ctx.controller.abort();
  answer.resolve({ approved: true });
  await check;
  assert.equal(h.controls.permission.behavior, 'deny');
});

test('Concurrent executors cannot steal a dedicated participant/project session', async () => {
  const h = sdkHarness('wait'), ctx = context();
  const check = assert.rejects(h.adapter.execute(ctx), { code: 'CANCELLED' });
  await until(() => h.calls.length > 0);
  await assert.rejects(h.adapter.execute(context()), { code: 'SESSION_BUSY' });
  ctx.controller.abort(); await check;
});

test('Pre-aborted signals, oversized prompts and invalid MCP never start native execution', async () => {
  for (const make of [() => codexHarness(), () => sdkHarness()]) {
    const h = make(), aborted = context(); aborted.controller.abort();
    await assert.rejects(h.adapter.execute(aborted), { code: 'CANCELLED' });
    const large = context(); large.run.content = 'x'.repeat(LIMIT + 1);
    await assert.rejects(h.adapter.execute(large), { code: 'DATA_LIMIT' });
    const invalid = context(); invalid.mcpConfig.args = ['bad\0'];
    await assert.rejects(h.adapter.execute(invalid), { code: 'INVALID_CONFIG' });
  }
});

test('NativeRpc handles split UTF-8, bounded frames, malformed JSON and child disconnect', async () => {
  function wire() {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    return { child, rpc: new NativeRpc('unused', [], { spawnProcess: () => child, timeoutMs: 50, maxFrameBytes: 256 }) };
  }
  const { child, rpc } = wire();
  const request = rpc.request('test');
  const bytes = Buffer.from(JSON.stringify({ id: 1, result: '你好' }) + '\n');
  const cut = bytes.indexOf(Buffer.from('你好')) + 1;
  child.stdout.write(bytes.subarray(0, cut)); child.stdout.write(bytes.subarray(cut));
  assert.equal(await request, '你好'); rpc.close();
  for (const body of ['{broken\n', 'x'.repeat(257)]) {
    const w = wire(); const check = assert.rejects(w.rpc.request('test'));
    w.child.stdout.write(body); await check; assert(w.rpc.closed); w.rpc.close();
  }
  const w = wire(); const check = assert.rejects(w.rpc.request('test'), { code: 'NATIVE_DISCONNECTED' });
  w.child.emit('close'); await check; w.rpc.close();
});

test('Health is bounded setup evidence and does not claim native execution success', async () => {
  const a = codex({ execFile: async () => ({ stdout: 'codex-cli test-version\n' }) });
  assert.equal((await a.health()).state, 'available');
  assert.equal((await claude({ loadSDK: async () => ({}) }).health()).state, 'incompatible');
  assert.equal((await claude({ loadSDK: async () => { throw new Error('secret'); } }).health()).state, 'needs_setup');
});
test('explicit native artifact envelope preserves text and leaves path validation to Hub',async()=>{
 const {nativeResult}=await import('../src/adapters/coding-native.mjs')
 assert.deepEqual(nativeResult('{"text":"created","artifacts":["result.txt"]}'),{text:'created',artifacts:['result.txt']})
 assert.deepEqual(nativeResult('ordinary answer'),{text:'ordinary answer'})
 assert.deepEqual(nativeResult(['progress','{"text":"created","artifacts":["result.txt"]}']),{text:'created',artifacts:['result.txt']})
 assert.throws(()=>nativeResult('{"text":"created","artifacts":[{"path":"wrong"}]}'),{code:'INVALID_OUTPUT'})
})
