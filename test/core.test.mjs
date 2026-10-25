import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hub } from '../src/core/hub.mjs'
import { createAdapter as unagent } from '../src/adapters/unagent.mjs'
const admin={admin:true}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn,predicate,timeout=3000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(predicate(value))return value;await sleep(5)}throw new Error('Condition timed out')}
async function fixture(t,opts={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connect-core-'));const workspace=path.join(dir,'project');fs.mkdirSync(workspace)
 const hub=new Hub({stateDir:path.join(dir,'state'),tickMs:100000,...opts});t.after(()=>hub.close())
 const create=async(name,extra={})=>hub.call('participants.create',{name,provider:'manual',workspace,...extra},admin)
 const a=await create('A'),b=await create('B');const actorA=hub.authenticate(a.token),actorB=hub.authenticate(b.token)
 await hub.call('participants.update',{id:a.participant.id,allowedPeers:[b.participant.id]},admin);await hub.call('participants.update',{id:b.participant.id,allowedPeers:[a.participant.id]},admin)
 const send=(body={},actor=actorA)=>hub.call('runs.submit',{recipientId:b.participant.id,content:'work',idempotencyKey:'task',...body},actor)
 return {hub,dir,workspace,a,b,actorA,actorB,create,send}
}
test('manual inbox, authentication, scoped messages, idempotent execution and rework',async t=>{
 const x=await fixture(t);const {hub,actorA,actorB,b}=x
 assert.throws(()=>hub.authenticate('wrong'),{code:'UNAUTHORIZED'})
 await assert.rejects(hub.call('messages.send',{recipientId:b.participant.id,content:'x',idempotencyKey:'x',senderId:'fake'},actorA),{code:'FORBIDDEN'})
 const message=await hub.call('messages.send',{recipientId:b.participant.id,content:'hello',idempotencyKey:'m'},actorA)
 assert.equal((await hub.call('runs.list',{},actorA)).length,0)
 assert.equal((await hub.call('messages.list',{threadId:message.thread.id},actorB))[0].content,'hello')
 assert.ok((await hub.call('messages.ack',{messageId:message.message.id},actorB)).ackedAt)
 const run=await x.send();assert.equal((await x.send()).id,run.id)
 await assert.rejects(x.send({content:'different'}),{code:'IDEMPOTENCY_CONFLICT'})
 const claim=await hub.call('runs.claim',{runId:run.id,idempotencyKey:'claim'},actorB)
 const retry=await hub.call('runs.claim',{runId:run.id,idempotencyKey:'claim'},actorB);assert.equal(claim.executionToken,retry.executionToken)
 const payload={runId:run.id,executionToken:claim.executionToken,text:'done'}
 assert.equal((await hub.call('runs.complete',payload,actorB)).status,'completed')
 assert.equal((await hub.call('runs.complete',payload,actorB)).status,'completed')
 await assert.rejects(hub.call('runs.fail',{runId:run.id,executionToken:claim.executionToken,error:'late'},actorB),{code:'STALE_EXECUTION'})
 const revised=await hub.call('runs.rework',{runId:run.id,content:'revise',idempotencyKey:'revise'},actorA)
 assert.equal(revised.threadId,run.threadId);assert.equal(revised.round,2)
 await assert.rejects(hub.call('runs.complete',payload,actorB),{code:'STALE_EXECUTION'})
 assert.ok(!JSON.stringify(hub.events(0,actorA)).includes(claim.executionToken))
 assert.ok(!JSON.stringify(await hub.call('runs.get',{runId:run.id},actorA)).includes('credential'))
})
test('parallel claims serialize, unrelated project and peer access denied',async t=>{
 const x=await fixture(t);const c=await x.create('C');const actorC=x.hub.authenticate(c.token)
 await assert.rejects(x.hub.call('messages.send',{recipientId:x.b.participant.id,content:'x',idempotencyKey:'x'},actorC),{code:'FORBIDDEN'})
 const run=await x.send();await assert.rejects(x.hub.call('runs.get',{runId:run.id},actorC),{code:'NOT_FOUND'})
 const r=await Promise.allSettled(['one','two'].map(key=>x.hub.call('runs.claim',{runId:run.id,idempotencyKey:key},x.actorB)))
 assert.equal(r.filter(v=>v.status==='fulfilled').length,1)
 const elsewhere=path.join(x.dir,'elsewhere');fs.mkdirSync(elsewhere);const d=await x.create('D',{workspace:elsewhere})
 await assert.rejects(x.hub.call('runs.submit',{senderId:x.a.participant.id,recipientId:d.participant.id,content:'x',idempotencyKey:'other'},admin),{code:'FORBIDDEN'})
})
test('manual clarification fences previous claim; another agent cannot grant user approval',async t=>{
 const x=await fixture(t);const run=await x.send();const c=await x.hub.call('runs.claim',{runId:run.id,idempotencyKey:'c'},x.actorB)
 await assert.rejects(x.hub.call('questions.ask',{runId:run.id,executionToken:c.executionToken,kind:'approval',text:'approve'},x.actorB),{code:'FORBIDDEN'})
 const q=await x.hub.call('questions.ask',{runId:run.id,executionToken:c.executionToken,kind:'clarification',text:'which?'},x.actorB)
 await assert.rejects(x.hub.call('questions.answer',{questionId:q.id,approved:true},x.actorA),{code:'FORBIDDEN'})
 await x.hub.call('questions.answer',{questionId:q.id,answer:'first'},x.actorA)
 const fresh=await x.hub.call('runs.claim',{runId:run.id,idempotencyKey:'fresh'},x.actorB)
 assert.notEqual(fresh.executionToken,c.executionToken);assert.equal(fresh.run.lastAnswer.answer,'first')
 await assert.rejects(x.hub.call('runs.complete',{runId:run.id,executionToken:c.executionToken,text:'old'},x.actorB),{code:'STALE_EXECUTION'})
})
test('lease expiration and restart keep uncertainty until explicit user reset',async t=>{
 let now=1000;const x=await fixture(t,{now:()=>now,leaseMs:100})
 const run=await x.send();const c=await x.hub.call('runs.claim',{runId:run.id,idempotencyKey:'c'},x.actorB)
 now+=101;x.hub.tick();assert.equal((await x.hub.call('runs.get',{runId:run.id},x.actorA)).status,'interrupted')
 await assert.rejects(x.hub.call('runs.complete',{runId:run.id,executionToken:c.executionToken,text:'old'},x.actorB),{code:'STALE_EXECUTION'})
 await assert.rejects(x.hub.call('runs.reset',{runId:run.id,confirmStopped:true},x.actorB),{code:'FORBIDDEN'})
 await x.hub.call('runs.reset',{runId:run.id,confirmStopped:true},admin)
 const fresh=await x.hub.call('runs.claim',{runId:run.id,idempotencyKey:'fresh'},x.actorB)
 await x.hub.close();const reopened=new Hub({stateDir:path.join(x.dir,'state'),tickMs:100000});t.after(()=>reopened.close())
 const interrupted=await reopened.call('runs.get',{runId:run.id},reopened.authenticate(x.a.token));assert.equal(interrupted.status,'interrupted')
 await assert.rejects(reopened.call('runs.complete',{runId:run.id,executionToken:fresh.executionToken,text:'late'},reopened.authenticate(x.b.token)),{code:'STALE_EXECUTION'})
})
test('artifact realpath rejects symlinks and config files outside authorized output',async t=>{
 const x=await fixture(t);const run=await x.send();const c=await x.hub.call('runs.claim',{runId:run.id,idempotencyKey:'c'},x.actorB)
 fs.writeFileSync(path.join(x.dir,'secret'),'private');fs.symlinkSync(path.join(x.dir,'secret'),path.join(x.workspace,'link'))
 await assert.rejects(x.hub.call('runs.complete',{runId:run.id,executionToken:c.executionToken,text:'done',artifacts:['link']},x.actorB),{code:'INVALID_OUTPUT'})
 fs.writeFileSync(path.join(x.workspace,'result.txt'),'ok')
 const r=await x.hub.call('runs.complete',{runId:run.id,executionToken:c.executionToken,text:'done',artifacts:['result.txt']},x.actorB)
 assert.equal(r.result.artifacts[0].bytes,2)
})
test('revocation cancels both directions and descendants, rejects delayed admissions',async t=>{
 const x=await fixture(t);const run=await x.send();await x.hub.call('participants.revoke',{id:x.b.participant.id},admin)
 assert.equal((await x.hub.call('runs.get',{runId:run.id},admin)).status,'cancelled')
 assert.throws(()=>x.hub.authenticate(x.b.token),{code:'UNAUTHORIZED'})
 await assert.rejects(x.send({idempotencyKey:'late'}),{code:'NOT_FOUND'})
})
test('managed child waits release capacity and resume without rerunning native execution',async t=>{
 let childId,executeCount=0,hub;let childActor
 const adapter={id:'codex',capabilities:{automaticExecution:true},health:async()=>({state:'available'}),cancel:async()=>({stopped:true}),execute:async ctx=>{
  executeCount++;const credential=ctx.mcpConfig.env.UNAGENT_CONNECT_EXECUTION_TOKEN
  const child=await hub.call('runs.submit',{recipientId:childActor.participant.id,content:'child',idempotencyKey:'child',parentRunId:ctx.run.id,executionToken:credential},{participantId:ctx.participant.id});childId=child.id
  let r=await hub.call('runs.wait',{runId:child.id,parentRunId:ctx.run.id,executionToken:credential,timeoutMs:0},{participantId:ctx.participant.id})
  while(r.status!=='completed'){await sleep(5);r=await hub.call('runs.wait',{runId:child.id,parentRunId:ctx.run.id,executionToken:credential,timeoutMs:20},{participantId:ctx.participant.id})}
  return {text:'parent:'+r.result.text,nativeSessionId:'native-one'}
 }}
 const x=await fixture(t,{adapters:[adapter]});hub=x.hub
 const worker=await x.create('managed',{provider:'codex',autoExecute:true});childActor=await x.create('manual-child')
 await hub.call('participants.update',{id:worker.participant.id,allowedPeers:[childActor.participant.id]},admin)
 const root=await hub.call('runs.submit',{senderId:x.a.participant.id,recipientId:worker.participant.id,content:'parent',idempotencyKey:'parent'},admin)
 await until(()=>hub.call('runs.get',{runId:root.id},admin),r=>r.status==='waiting_dependency')
 const claim=await hub.call('runs.claim',{runId:childId,idempotencyKey:'take'},hub.authenticate(childActor.token))
 await hub.call('runs.complete',{runId:childId,executionToken:claim.executionToken,text:'child-done'},hub.authenticate(childActor.token))
 const done=await until(()=>hub.call('runs.get',{runId:root.id},admin),r=>r.status==='completed')
 assert.equal(done.result.text,'parent:child-done');assert.equal(executeCount,1);assert.equal(done.nativeSessionId,'native-one')
})
test('native approval blocks on local-user answer and preserves project lock',async t=>{
 let asked
 const adapter={id:'codex',capabilities:{automaticExecution:true},health:async()=>({state:'available'}),cancel:async()=>({stopped:true}),execute:async ctx=>{asked=await ctx.ask({kind:'approval',text:'Write the authorized output?'});return{text:asked.approved?'approved':'denied'}}}
 const x=await fixture(t,{adapters:[adapter]});const worker=await x.create('managed',{provider:'codex',autoExecute:true})
 const run=await x.hub.call('runs.submit',{senderId:x.a.participant.id,recipientId:worker.participant.id,content:'work',idempotencyKey:'work'},admin)
 const waiting=await until(()=>x.hub.call('runs.get',{runId:run.id},admin),r=>r.status==='waiting_approval')
 await assert.rejects(x.hub.call('questions.answer',{questionId:waiting.question.id,approved:true},x.actorA),{code:'FORBIDDEN'})
 await x.hub.call('questions.answer',{questionId:waiting.question.id,approved:false},admin)
 const done=await until(()=>x.hub.call('runs.get',{runId:run.id},admin),r=>r.status==='completed');assert.equal(done.result.text,'denied')
})
test('failed cancellation keeps native lock until stop evidence or explicit reset',async t=>{
 let nativeResolve
 const adapter={id:'codex',capabilities:{automaticExecution:true},health:async()=>({state:'available'}),execute:async()=>new Promise(resolve=>{nativeResolve=resolve}),cancel:async()=>({stopped:false})}
 const x=await fixture(t,{adapters:[adapter]});const worker=await x.create('managed',{provider:'codex',autoExecute:true})
 const r=await x.hub.call('runs.submit',{senderId:x.a.participant.id,recipientId:worker.participant.id,content:'work',idempotencyKey:'work'},admin)
 await until(()=>x.hub.call('runs.get',{runId:r.id},admin),r=>r.status==='running')
 assert.equal((await x.hub.call('runs.cancel',{runId:r.id},admin)).status,'cancel_requested')
 await assert.rejects(x.hub.call('runs.reset',{runId:r.id,confirmStopped:true},admin),{code:'BUSY'})
 const other=await x.send();await assert.rejects(x.hub.call('runs.claim',{runId:other.id,idempotencyKey:'take'},x.actorB),{code:'BUSY'})
 nativeResolve({text:'stopped'});await until(()=>x.hub.call('runs.get',{runId:r.id},admin),r=>r.status==='cancelled')
 assert.ok(await x.hub.call('runs.claim',{runId:other.id,idempotencyKey:'take'},x.actorB))
})
test('unresponsive cancellation is bounded, deduplicated and retains locks until late stop evidence',async t=>{
 let acknowledge,ctx,cancels=0
 const adapter={id:'codex',capabilities:{automaticExecution:true},health:async()=>({state:'available'}),execute:async value=>{ctx=value;return new Promise(()=>{})},cancel:()=>{cancels++;return new Promise(resolve=>{acknowledge=resolve})}}
 const x=await fixture(t,{adapters:[adapter],cancelTimeoutMs:25});const worker=await x.create('managed',{provider:'codex',autoExecute:true})
 const run=await x.send({senderId:x.a.participant.id,recipientId:worker.participant.id},admin)
 await until(()=>ctx,Boolean)
 const requests=[1,2].map(()=>x.hub.call('runs.cancel',{runId:run.id},admin))
 const results=await Promise.race([Promise.all(requests),sleep(1000).then(()=>{throw new Error('Cancellation control channel hung')})])
 assert.ok(results.every(r=>r.status==='cancel_requested'));assert.equal(cancels,1);assert.equal(ctx.signal.aborted,true)
 const other=await x.send({idempotencyKey:'other'})
 await assert.rejects(x.hub.call('runs.claim',{runId:other.id,idempotencyKey:'take'},x.actorB),{code:'BUSY'})
 // Revocation remains available even while the same native stop request hangs.
 await x.hub.call('participants.revoke',{id:worker.participant.id},admin)
 assert.throws(()=>x.hub.authenticate(worker.token),{code:'UNAUTHORIZED'});assert.equal(cancels,1)
 acknowledge({stopped:true})
 await until(()=>x.hub.call('runs.get',{runId:run.id},admin),r=>r.status==='cancelled')
 assert.ok(await x.hub.call('runs.claim',{runId:other.id,idempotencyKey:'take'},x.actorB))
})
test('real UNagent stop readback persists after supervision credentials are fenced',async t=>{
 let acknowledge,ctx
 const config={bridgeDir:'/test-connector',instanceId:'test-instance',clientProfile:'test-client'}
 const native=unagent({call:async(c,method,p)=>{
  if(method==='tasks.cancel')return new Promise(resolve=>{acknowledge=resolve})
  assert.equal(method,'tasks.get');return{id:p.taskId,targetSessionId:'native-session',status:'cancelled'}
 }})
 const adapter={...native,execute:async value=>{ctx=value;ctx.saveBinding({nativeSessionId:'native-session',nativeBinding:{provider:'unagent',workspace:ctx.run.workspace,participantId:ctx.participant.id,attemptId:ctx.run.attemptId,sessionId:'native-session',taskId:'native-task',...config,terminal:false}});return new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Supervision ended'),{code:'OUTCOME_UNKNOWN'})),{once:true}))}}
 const x=await fixture(t,{adapters:[adapter],cancelTimeoutMs:25});const worker=await x.create('managed',{provider:'unagent',autoExecute:true,config})
 const run=await x.send({senderId:x.a.participant.id,recipientId:worker.participant.id},admin);await until(()=>ctx?.run.nativeBinding,Boolean)
 await x.hub.call('runs.cancel',{runId:run.id},admin);await until(()=>!x.hub.active.has(run.id),Boolean)
 assert.equal(x.hub.store.get('run',run.id).credentialHash,undefined)
 assert.throws(()=>ctx.saveBinding({nativeSessionId:'foreign',nativeBinding:{...ctx.run.nativeBinding,sessionId:'foreign',terminal:true}}),{code:'STALE_EXECUTION'})
 acknowledge({})
 await until(()=>x.hub.call('runs.get',{runId:run.id},admin),r=>r.status==='cancelled')
 assert.equal(x.hub.store.get('run',run.id).nativeBinding.terminal,true);assert.equal(x.hub.capacity(),0)
})
test('late cancellation acknowledgement cannot terminate a reset execution',async t=>{
 let acknowledge,ctx
 const adapter={id:'codex',capabilities:{automaticExecution:true},health:async()=>({state:'available'}),execute:async value=>{ctx=value;return new Promise((resolve,reject)=>value.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Supervision ended'),{code:'OUTCOME_UNKNOWN'})),{once:true}))},cancel:()=>new Promise(resolve=>{acknowledge=resolve})}
 const x=await fixture(t,{adapters:[adapter],cancelTimeoutMs:25});const worker=await x.create('managed',{provider:'codex',autoExecute:true})
 const run=await x.send({senderId:x.a.participant.id,recipientId:worker.participant.id},admin);await until(()=>ctx,Boolean)
 await x.hub.call('runs.cancel',{runId:run.id},admin)
 await until(()=>!x.hub.active.has(run.id),Boolean)
 await x.hub.call('participants.update',{id:worker.participant.id,autoExecute:false},admin)
 const reset=await x.hub.call('runs.reset',{runId:run.id,confirmStopped:true},admin)
 const claim=await x.hub.call('runs.claim',{runId:run.id,idempotencyKey:'new-attempt'},x.hub.authenticate(worker.token))
 acknowledge({stopped:true});await sleep(10)
 const current=await x.hub.call('runs.get',{runId:run.id},admin)
 assert.notEqual(reset.attemptId,run.attemptId);assert.equal(current.status,'running');assert.equal(current.attemptId,claim.run.attemptId)
})
test('same-recipient dependency waits do not block earlier tasks, handoff loops and chain rounds are bounded',async t=>{
 const x=await fixture(t);const first=await x.send();const second=await x.send({content:'second',idempotencyKey:'second',dependencyRunIds:[first.id]})
 assert.equal(second.status,'waiting_dependency')
 const c=await x.hub.call('runs.claim',{runId:first.id,idempotencyKey:'take'},x.actorB)
 await assert.rejects(x.hub.call('runs.submit',{recipientId:x.b.participant.id,content:'loop',idempotencyKey:'loop',parentRunId:first.id,executionToken:c.executionToken},x.actorB),{code:'CYCLE'})
 await x.hub.call('runs.complete',{runId:first.id,executionToken:c.executionToken,text:'done'},x.actorB)
 const secondClaim=await x.hub.call('runs.claim',{runId:second.id,idempotencyKey:'second'},x.actorB)
 await x.hub.call('runs.complete',{runId:second.id,executionToken:secondClaim.executionToken,text:'second done'},x.actorB)
 for(let round=2;round<=8;round++){
  await x.hub.call('runs.rework',{runId:first.id,content:'round '+round,idempotencyKey:'round '+round},x.actorA)
  const c=await x.hub.call('runs.claim',{runId:first.id,idempotencyKey:'take '+round},x.actorB)
  await x.hub.call('runs.complete',{runId:first.id,executionToken:c.executionToken,text:'done'},x.actorB)
 }
 await assert.rejects(x.hub.call('runs.rework',{runId:first.id,content:'too many',idempotencyKey:'round9'},x.actorA),{code:'LIMIT_REACHED'})
})
test('origin clarification temporarily wakes parent control without deadlocking the single execution slot',async t=>{
 let hub,child;let executions=0
 const adapter={id:'codex',capabilities:{automaticExecution:true},health:async()=>({state:'available'}),cancel:async()=>({stopped:true}),execute:async ctx=>{
  executions++
  if(ctx.participant.name==='child'){const answer=await ctx.ask({kind:'clarification',text:'which version?'});return{text:'version:'+answer.answer}}
  const actor={participantId:ctx.participant.id},executionToken=ctx.mcpConfig.env.UNAGENT_CONNECT_EXECUTION_TOKEN
  const c=await hub.call('runs.submit',{recipientId:child.participant.id,content:'clarify',idempotencyKey:'child',parentRunId:ctx.run.id,executionToken},actor)
  let r
  do{r=await hub.call('runs.wait',{runId:c.id,parentRunId:ctx.run.id,executionToken,timeoutMs:50},actor)}while(r.status==='queued'||r.status==='running')
  assert.equal(r.status,'waiting_question');assert.equal((await hub.call('runs.get',{runId:ctx.run.id},actor)).status,'running')
  await hub.call('questions.answer',{questionId:r.question.id,answer:'two'},actor)
  do{r=await hub.call('runs.wait',{runId:c.id,parentRunId:ctx.run.id,executionToken,timeoutMs:50},actor)}while(r.status!=='completed')
  return{text:r.result.text}
 }}
 const x=await fixture(t,{adapters:[adapter]});hub=x.hub;const parent=await x.create('parent',{provider:'codex',autoExecute:true});child=await x.create('child',{provider:'codex',autoExecute:true})
 await hub.call('participants.update',{id:parent.participant.id,allowedPeers:[child.participant.id]},admin)
 const r=await hub.call('runs.submit',{senderId:x.a.participant.id,recipientId:parent.participant.id,content:'go',idempotencyKey:'origin'},admin)
 const done=await until(()=>hub.call('runs.get',{runId:r.id},admin),r=>r.status==='completed',5000)
 assert.equal(done.result.text,'version:two');assert.equal(executions,2)
})
test('native recovery queries saved attempt and never resubmits uncertain work',async t=>{
 let executes=0,queries=0
 const adapter={id:'codex',capabilities:{automaticExecution:true},health:async()=>({state:'available'}),cancel:async()=>({stopped:false}),execute:async ctx=>{executes++;ctx.saveBinding({nativeSessionId:'original',nativeBinding:{attemptId:ctx.run.attemptId,requestId:'original-request'}});throw Object.assign(new Error('response lost'),{code:'OUTCOME_UNKNOWN'})},recover:async ctx=>{queries++;assert.equal(ctx.run.nativeBinding.requestId,'original-request');return{text:'original result'}}}
 const x=await fixture(t,{adapters:[adapter]});const worker=await x.create('worker',{provider:'codex',autoExecute:true});const r=await x.hub.call('runs.submit',{senderId:x.a.participant.id,recipientId:worker.participant.id,content:'work',idempotencyKey:'work'},admin)
 await until(()=>x.hub.call('runs.get',{runId:r.id},admin),r=>r.status==='uncertain')
 await x.hub.call('runs.recover',{runId:r.id},admin)
 const done=await until(()=>x.hub.call('runs.get',{runId:r.id},admin),r=>r.status==='completed');assert.equal(done.result.text,'original result');assert.equal(executes,1);assert.equal(queries,1)
})
test('event pages stay below HTTP response bounds without skipping large visible records',async t=>{
 const x=await fixture(t);for(let n=0;n<14;n++)await x.hub.call('messages.send',{recipientId:x.b.participant.id,content:'x'.repeat(99999),idempotencyKey:'large'+n},x.actorA)
 let after=0,seen=0;for(let i=0;i<10;i++){const batch=x.hub.events(after,x.actorB);assert.ok(Buffer.byteLength(JSON.stringify(batch))<1024*1024);seen+=batch.events.filter(e=>e.type==='message.created').length;if(batch.nextCursor===after)break;after=batch.nextCursor}
 assert.equal(seen,14)
})
