import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Store } from './store.mjs'
import { assert, fail, hash, equalHash, text, object, number, keys, canonicalDirectory, privateFile, token, redact, validateArtifacts } from './security.mjs'

const TERMINAL=new Set(['completed','failed','cancelled'])
const INPUT=new Set(['waiting_question','waiting_approval','interrupted','uncertain','paused','cancel_requested'])
const PROVIDERS=['manual','unagent','codex','claude','workbuddy','harness']
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const publicParticipant=p=>Object.fromEntries(['id','name','provider','workspace','purpose','autoExecute','allowedPeers','revokedAt','createdAt','updatedAt'].map(k=>[k,p[k]]))
const publicRun=r=>Object.fromEntries(['id','threadId','senderId','recipientId','workspace','content','status','round','attemptId','rootRunId','parentRunId','dependencyRunIds','nativeSessionId','result','question','lastAnswer','error','deadlineAt','createdAt','updatedAt','revision'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]))
const stable=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(stable).join(',')}]`:`{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')}}`
const id=kind=>`${kind}-${randomUUID()}`

export class Hub {
  constructor({stateDir=path.join(os.homedir(),'.unagent','connect'),adapters=[],now=Date.now,maxConcurrent=1,leaseMs=60000,url='http://127.0.0.1:18492',tickMs=1000}={}) {
    this.store=new Store(stateDir);this.stateDir=this.store.directory;this.now=now;this.maxConcurrent=number(maxConcurrent,1,1,16);this.leaseMs=leaseMs;this.url=url
    this.adapters=new Map((adapters instanceof Map?[...adapters.values()]:Array.isArray(adapters)?adapters:Object.values(adapters)).map(a=>[a.id,a]))
    this.listeners=new Set();this.active=new Map();this.closed=false;this.pumping=false;this.pumpAgain=false
    const adminFile=path.join(this.stateDir,'admin.token')
    if(!fs.existsSync(adminFile))privateFile(adminFile,token())
    assert(fs.lstatSync(adminFile).isFile()&&!fs.lstatSync(adminFile).isSymbolicLink(),'INVALID_STATE','Admin credential must be a private regular file')
    fs.chmodSync(adminFile,0o600);this.adminToken=fs.readFileSync(adminFile,'utf8').trim();assert(/^[a-f0-9]{64}$/.test(this.adminToken),'INVALID_STATE','Invalid admin credential')
    this.store.tx(()=>{for(const r of this.store.list('run'))if(!TERMINAL.has(r.status)&&r.status!=='queued'&&r.held){r.status='interrupted';r.error='Service restarted; inspect native execution before resetting.';r.credential=undefined;r.credentialHash=undefined;this.saveRun(r)}})
    this.timer=setInterval(()=>{try{this.tick();this.schedule()}catch{}},tickMs);this.timer.unref?.()
  }
  setUrl(url){this.url=url}
  authenticate(value){
    assert(typeof value==='string'&&value.length<=512,'UNAUTHORIZED','Missing credential',401)
    if(equalHash(hash(value),hash(this.adminToken)))return {admin:true}
    const p=this.store.list('participant').find(p=>!p.revokedAt&&equalHash(p.tokenHash,hash(value)))
    assert(p,'UNAUTHORIZED','Invalid or revoked credential',401);return {participantId:p.id}
  }
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  changed(type,data,audience=[],runId,threadId){this.store.event({type,data,audience,runId,threadId,createdAt:this.now()});queueMicrotask(()=>{if(!this.closed)for(const fn of this.listeners)try{fn()}catch{}})}
  saveRun(r){r.updatedAt=this.now();r.revision=(r.revision??0)+1;this.store.put('run',r);this.changed('run.updated',publicRun(r),[r.senderId,r.recipientId],r.id,r.threadId);return r}
  participant(pid){const p=this.store.get('participant',pid);assert(p&&!p.revokedAt,'NOT_FOUND','Participant is missing or revoked',404);return p}
  admin(actor){assert(actor?.admin===true,'FORBIDDEN','This operation is reserved for the local user',403)}
  sender(p,actor){if(actor.admin)return this.participant(text(p.senderId,'senderId',160));assert(!('senderId'in p),'FORBIDDEN','Sender identity is bound by authentication',403);return this.participant(actor.participantId)}
  canPeer(sender,recipient,actor){assert(sender.workspace===recipient.workspace,'FORBIDDEN','Participants must share an authorized project',403);assert(actor.admin||sender.id===recipient.id||sender.allowedPeers.includes(recipient.id),'FORBIDDEN','Recipient is not in this entry’s allowed peers',403)}
  visibleThread(t,actor){return actor.admin||t.participantIds.includes(actor.participantId)}
  run(rid,actor){const r=this.store.get('run',rid);assert(r&&this.canSeeRun(r,actor),'NOT_FOUND','Task not found',404);return r}
  canSeeRun(r,actor){if(actor.admin||r.senderId===actor.participantId||r.recipientId===actor.participantId)return true;let cursor=r;const seen=new Set();while(cursor?.parentRunId&&!seen.has(cursor.id)){seen.add(cursor.id);cursor=this.store.get('run',cursor.parentRunId);if(cursor&&(cursor.senderId===actor.participantId||cursor.recipientId===actor.participantId))return true}return false}
  authorizeExecution(r,p,actor){assert(r.managed||r.status!=='running'||r.leaseUntil>this.now(),'STALE_EXECUTION','Recipient lease expired',409);assert(actor.admin||actor.participantId===r.recipientId,'FORBIDDEN','Only recipient may execute this task',403);assert(typeof p.executionToken==='string'&&equalHash(hash(p.executionToken),r.credentialHash),'STALE_EXECUTION','Execution credential is missing or stale',409);assert(!TERMINAL.has(r.status)&&!['interrupted','uncertain','paused'].includes(r.status),'STALE_EXECUTION','Execution ended or needs user inspection',409)}
  idem(method,p,actor,fn){const key=text(p.idempotencyKey,'idempotencyKey',200);const identity=actor.admin?'admin':actor.participantId;const iid=hash(`${method}\0${identity}\0${key}`);const fingerprint=hash(stable(p));const prior=this.store.get('idem',iid);if(prior){assert(prior.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT','This key was already used with different parameters',409);return prior.result}const result=fn();this.store.put('idem',{id:iid,fingerprint,result});return result}
  config(value={}){object(value);const walk=v=>{if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){assert(!/^(token|apiKey|password|secret|authorization)$/i.test(k),'INVALID_ARGUMENT','Use local credential profiles, not inline secrets');walk(x)}};walk(value);assert(JSON.stringify(value).length<=16000,'INVALID_ARGUMENT','Adapter configuration too large');return structuredClone(value)}
  ensureThread(p,sender,recipient){if(p.threadId){const t=this.store.get('thread',p.threadId);assert(t&&t.participantIds.includes(sender.id)&&t.participantIds.includes(recipient.id),'FORBIDDEN','Thread does not belong to this pair',403);return t}const t={id:id('thread'),participantIds:[...new Set([sender.id,recipient.id])],title:p.title?text(p.title,'title',200):`${sender.name} → ${recipient.name}`,createdAt:this.now(),updatedAt:this.now()};this.store.put('thread',t);this.changed('thread.created',t,t.participantIds,undefined,t.id);return t}
  events(after=0,actor={admin:true},runId,limit=100){
    number(after,0,0,Number.MAX_SAFE_INTEGER);number(limit,100,1,500)
    const batch=this.store.events(after,1000),events=[];let bytes=0,truncated=false
    for(const event of batch){
      if(runId&&event.runId!==runId)continue
      if(!actor.admin&&!event.audience?.includes(actor.participantId)&&!(event.runId&&this.canSeeRun(this.store.get('run',event.runId)??{},actor)))continue
      const {audience,...visible}=event,size=Buffer.byteLength(JSON.stringify(visible))
      if(events.length>=limit||bytes+size>900000){truncated=true;break}
      events.push(visible);bytes+=size
    }
    return{events,nextCursor:truncated?(events.at(-1)?.id??after):(batch.at(-1)?.id??after)}
  }
  async call(method,input={},actor={}) {
    assert(!this.closed,'UNAVAILABLE','Hub is closed',503);object(actor);assert(actor.admin||actor.participantId,'UNAUTHORIZED','Authenticate first',401);if(!actor.admin)this.participant(actor.participantId)
    const p=object(input)
    for(const forbidden of ['actor','origin','sourceId','sourceSessionId','credentialHash','tokenHash'])assert(!(forbidden in p),'FORBIDDEN',`Caller cannot supply ${forbidden}`,403)
    if(method==='adapters.health'){this.admin(actor);const a=this.adapters.get(p.id);assert(a,'NOT_FOUND','Adapter not installed',404);return a.health(this.config(p.config))}
    if(method==='system.status'){this.admin(actor);return {version:'0.2.0',participants:this.store.list('participant').map(p=>({...publicParticipant(p),config: p.config})),runs:this.store.list('run').map(publicRun),adapters:[{id:'manual',capabilities:{manualMessaging:true,automaticExecution:false}},...[...this.adapters.values()].map(a=>({id:a.id,capabilities:a.capabilities}))]}}
    if(method==='runs.wait')return this.wait(p,actor)
    if(method==='runs.cancel')return this.cancel(p,actor)
    if(method==='runs.recover')return this.recover(p,actor)
    if(method==='participants.revoke')return this.revoke(p,actor)
    if(method==='events.list')return this.events(number(p.after,0,0,Number.MAX_SAFE_INTEGER),actor,p.runId,number(p.limit,100,1,500))
    const result=this.store.tx(()=>this.mutate(method,p,actor));this.schedule();return result
  }
  mutate(method,p,actor){
    switch(method){
      case 'participants.create': {
        this.admin(actor);keys(p,['name','provider','workspace','purpose','autoExecute','allowedPeers','config']);assert(PROVIDERS.includes(p.provider),'INVALID_ARGUMENT','Unsupported provider');assert(p.autoExecute===undefined||typeof p.autoExecute==='boolean','INVALID_ARGUMENT','autoExecute must be boolean')
        const credential=token();const now=this.now();const entry={id:id('agent'),name:text(p.name,'name',120),provider:p.provider,workspace:canonicalDirectory(p.workspace),purpose:p.purpose?text(p.purpose,'purpose',500):'',autoExecute:p.autoExecute===true,allowedPeers:this.peers(p.allowedPeers??[]),config:this.config(p.config),tokenHash:hash(credential),revokedAt:null,createdAt:now,updatedAt:now}
        if(entry.autoExecute)assert(this.adapters.get(entry.provider)?.capabilities.automaticExecution,'UNSUPPORTED','Adapter cannot execute automatically')
        privateFile(path.join(this.stateDir,'credentials',entry.id+'.token'),credential);this.store.put('participant',entry);this.changed('participant.created',publicParticipant(entry),[entry.id]);return {participant:publicParticipant(entry),token:credential}
      }
      case 'participants.update': {
        this.admin(actor);keys(p,['id','name','purpose','autoExecute','allowedPeers','config']);const entry=this.participant(p.id)
        if(p.name!==undefined)entry.name=text(p.name,'name',120);if(p.purpose!==undefined)entry.purpose=typeof p.purpose==='string'?p.purpose.slice(0,500):text(p.purpose,'purpose',500)
        if(p.autoExecute!==undefined){assert(typeof p.autoExecute==='boolean','INVALID_ARGUMENT','autoExecute must be boolean');if(p.autoExecute)assert(this.adapters.get(entry.provider)?.capabilities.automaticExecution,'UNSUPPORTED','Adapter cannot execute automatically');entry.autoExecute=p.autoExecute}
        if(p.allowedPeers!==undefined)entry.allowedPeers=this.peers(p.allowedPeers);if(p.config!==undefined){assert(!this.store.list('run').some(r=>r.recipientId===entry.id&&r.held&&!TERMINAL.has(r.status)),'BUSY','Finish active tasks before changing native session configuration',409);entry.config=this.config(p.config)}
        entry.updatedAt=this.now();this.store.put('participant',entry);this.changed('participant.updated',publicParticipant(entry),[entry.id]);return publicParticipant(entry)
      }
      case 'participants.rotateToken': {
        this.admin(actor);const entry=this.participant(p.id);const credential=token();const file=path.join(this.stateDir,'credentials',entry.id+'.token');assert(!fs.lstatSync(file).isSymbolicLink(),'INVALID_STATE','Credential is not a regular file');fs.writeFileSync(file,credential,{mode:0o600});entry.tokenHash=hash(credential);this.store.put('participant',entry);return {participant:publicParticipant(entry),token:credential}
      }
      case 'participants.list': return this.store.list('participant').filter(e=>!e.revokedAt&&(actor.admin||e.id===actor.participantId||this.participant(actor.participantId).allowedPeers.includes(e.id))).map(publicParticipant)
      case 'threads.create': {
        keys(p,['recipientId','title','idempotencyKey','senderId']);const sender=this.sender(p,actor),recipient=this.participant(p.recipientId);this.canPeer(sender,recipient,actor);return this.idem(method,p,actor,()=>this.ensureThread(p,sender,recipient))
      }
      case 'threads.list':return this.store.list('thread').filter(t=>this.visibleThread(t,actor))
      case 'messages.send': {
        keys(p,['recipientId','threadId','content','idempotencyKey','senderId']);const sender=this.sender(p,actor),recipient=this.participant(p.recipientId);this.canPeer(sender,recipient,actor)
        return this.idem(method,p,actor,()=>{const thread=this.ensureThread(p,sender,recipient);const message={id:id('msg'),threadId:thread.id,senderId:sender.id,recipientId:recipient.id,content:redact(text(p.content,'content')),createdAt:this.now(),ackedAt:null};this.store.put('message',message);this.changed('message.created',message,thread.participantIds,undefined,thread.id);return {message,thread}})
      }
      case 'messages.list': {keys(p,['threadId','after','limit']);const t=this.store.get('thread',p.threadId);assert(t&&this.visibleThread(t,actor),'NOT_FOUND','Thread not found',404);const list=this.store.list('message').filter(m=>m.threadId===t.id);const start=p.after?list.findIndex(m=>m.id===p.after)+1:0;assert(!p.after||start>0,'INVALID_CURSOR','Unknown message cursor');return list.slice(start,start+number(p.limit,50,1,200))}
      case 'messages.ack':{keys(p,['messageId']);const m=this.store.get('message',p.messageId);assert(m&&(actor.admin||m.recipientId===actor.participantId),'NOT_FOUND','Message not found',404);m.ackedAt??=this.now();this.store.put('message',m);return m}
      case 'runs.submit':return this.submit(p,actor)
      case 'runs.list':return this.store.list('run').filter(r=>this.canSeeRun(r,actor)).map(publicRun)
      case 'runs.get':return publicRun(this.run(p.runId,actor))
      case 'inbox.list':return this.store.list('run').filter(r=>actor.admin||r.recipientId===actor.participantId).map(publicRun)
      case 'runs.claim':{keys(p,['runId','idempotencyKey']);const r=this.run(p.runId,actor);assert(actor.admin||r.recipientId===actor.participantId,'FORBIDDEN','Recipient only',403);text(p.idempotencyKey,'idempotencyKey',200);if(r.status==='running'&&r.claimKey===p.idempotencyKey){assert(r.managed||r.leaseUntil>this.now(),'STALE_EXECUTION','Recipient lease expired',409);return {run:publicRun(r),executionToken:r.credential}}return this.claim(r,p.idempotencyKey,false)}
      case 'runs.heartbeat':{keys(p,['runId','executionToken']);const r=this.run(p.runId,actor);this.authorizeExecution(r,p,actor);assert(r.status==='running','INVALID_STATE','Task is not running',409);r.leaseUntil=this.now()+this.leaseMs;this.saveRun(r);return publicRun(r)}
      case 'runs.complete':case 'runs.fail':return this.finish(method,p,actor)
      case 'runs.rework':return this.rework(p,actor)
      case 'runs.reset': {
        this.admin(actor);keys(p,['runId','confirmStopped']);const r=this.run(p.runId,actor);assert(p.confirmStopped===true,'CONFIRM_REQUIRED','Confirm native execution stopped before resetting');assert(['interrupted','uncertain','cancel_requested','paused'].includes(r.status),'INVALID_STATE','Only interrupted/uncertain tasks may be reset');assert(!this.active.has(r.id),'BUSY','Native adapter is still active; stop it before resetting',409)
        r.status='queued';r.held=false;r.managed=false;r.error=undefined;r.credential=undefined;r.credentialHash=undefined;r.question=undefined;r.deadlineAt=this.now()+1800000;r.attemptId=id('attempt');this.cancelQuestions(r.id);return publicRun(this.saveRun(r))
      }
      case 'questions.ask':return this.openQuestion(p,actor)
      case 'questions.answer':return this.answerQuestion(p,actor)
      default:fail('METHOD_NOT_FOUND',`Unknown method: ${method}`,404)
    }
  }
  peers(value){assert(Array.isArray(value)&&value.length<=200&&value.every(v=>typeof v==='string'&&v.length<=160),'INVALID_ARGUMENT','allowedPeers must be an ID list');return [...new Set(value)]}
  submit(p,actor){
    keys(p,['recipientId','threadId','content','idempotencyKey','senderId','parentRunId','executionToken','dependencyRunIds']);const sender=this.sender(p,actor),recipient=this.participant(p.recipientId);this.canPeer(sender,recipient,actor)
    return this.idem('runs.submit',p,actor,()=>{
      let parent,root;const dependencies=this.peers(p.dependencyRunIds??[])
      if(p.parentRunId){parent=this.run(p.parentRunId,actor);this.authorizeExecution(parent,p,actor);assert(parent.recipientId===sender.id,'FORBIDDEN','Parent must belong to the sending executor');root=this.store.get('run',parent.rootRunId);assert(parent.workspace===sender.workspace,'FORBIDDEN','Parent project does not match');assert((parent.depth??0)<4,'LIMIT_REACHED','Maximum task transfer depth reached');assert(this.store.list('run').filter(r=>r.rootRunId===root.id).reduce((sum,r)=>sum+r.round,0)<8,'LIMIT_REACHED','Maximum root task rounds reached');let cursor=parent;while(cursor){assert(cursor.recipientId!==recipient.id,'CYCLE','Cannot delegate back into an ancestor recipient');cursor=cursor.parentRunId?this.store.get('run',cursor.parentRunId):null}}
      for(const dep of dependencies){const r=this.run(dep,actor);assert(r.workspace===sender.workspace,'FORBIDDEN','Dependency is outside project');assert(!parent||r.rootRunId===parent.rootRunId,'INVALID_ARGUMENT','Dependencies must belong to the same root')}
      const thread=this.ensureThread(p,sender,recipient);const rid=id('run');const now=this.now();const r={id:rid,threadId:thread.id,senderId:sender.id,recipientId:recipient.id,workspace:sender.workspace,content:redact(text(p.content,'content')),status:dependencies.some(d=>!TERMINAL.has(this.store.get('run',d).status))?'waiting_dependency':'queued',round:1,attemptId:id('attempt'),rootRunId:root?.id??rid,parentRunId:parent?.id??null,depth:parent?(parent.depth??0)+1:0,dependencyRunIds:dependencies,deadlineAt:root?.deadlineAt??now+1800000,createdAt:now,updatedAt:now,revision:0,held:false}
      if(dependencies.some(d=>['failed','cancelled'].includes(this.store.get('run',d).status))){r.status='failed';r.error='A dependency did not complete'}
      this.saveRun(r);return publicRun(r)
    })
  }
  capacity(){return this.store.list('run').filter(r=>r.held&&['running','uncertain','interrupted','cancel_requested','paused'].includes(r.status)).length}
  canClaim(r){
    if(r.status!=='queued'||r.deadlineAt<=this.now()||this.capacity()>=this.maxConcurrent)return false
    const records=this.store.list('run');if(r.dependencyRunIds.some(d=>this.store.get('run',d)?.status!=='completed'))return false
    for(const other of records){if(other.id===r.id||!other.held||TERMINAL.has(other.status))continue
      if(other.recipientId===r.recipientId||other.nativeSessionId&&other.nativeSessionId===r.nativeSessionId)return false
      if(other.workspace===r.workspace&&!(other.rootRunId===r.rootRunId&&other.status==='waiting_dependency'))return false
    }
    return !records.some(other=>other.id!==r.id&&other.recipientId===r.recipientId&&other.status==='queued'&&(other.createdAt<r.createdAt||other.createdAt===r.createdAt&&other.id<r.id)&&other.dependencyRunIds.every(d=>this.store.get('run',d)?.status==='completed'))
  }
  claim(r,key,managed){
    assert(this.canClaim(r),'BUSY','Task is not claimable; a prior task, dependency or native lock is active',409)
    this.participant(r.senderId);const recipient=this.participant(r.recipientId);const credential=token();r.status='running';r.held=true;r.managed=managed;r.claimKey=key;r.credential=credential;r.credentialHash=hash(credential);r.leaseUntil=this.now()+this.leaseMs
    const binding=this.store.get('binding',recipient.id);if(binding){r.nativeSessionId=binding.nativeSessionId;r.nativeBinding=binding.nativeBinding}
    this.saveRun(r);return {run:publicRun(r),executionToken:credential}
  }
  finish(method,p,actor){
    keys(p,method==='runs.complete'?['runId','executionToken','text','artifacts']:['runId','executionToken','error']);const r=this.run(p.runId,actor)
    assert(actor.admin||actor.participantId===r.recipientId,'FORBIDDEN','Recipient only',403)
    const fingerprint=hash(stable({method,...p}));if(TERMINAL.has(r.status)){assert(r.finishFingerprint===fingerprint&&r.credentialHash===hash(p.executionToken??''),'STALE_EXECUTION','Different or stale terminal submission',409);return publicRun(r)}
    this.authorizeExecution(r,p,actor);assert(r.status==='running','INVALID_STATE','Task is not running',409)
    if(method==='runs.complete'){assert(!this.store.list('run').some(c=>c.parentRunId===r.id&&!TERMINAL.has(c.status)),'DEPENDENCY_PENDING','Finish or cancel child tasks before completion',409);r.result={text:redact(text(p.text,'text')),artifacts:validateArtifacts(r.workspace,p.artifacts)};r.status='completed'}else{r.error=redact(text(p.error,'error',4000));r.status='failed'}
    r.finishFingerprint=fingerprint;r.held=false;r.credential=undefined;r.question=undefined;this.cancelQuestions(r.id);this.saveRun(r);this.refreshDependencies();return publicRun(r)
  }
  rework(p,actor){keys(p,['runId','content','idempotencyKey']);const r=this.run(p.runId,actor);assert(actor.admin||r.senderId===actor.participantId,'FORBIDDEN','Only task sender may request rework',403)
    return this.idem('runs.rework',p,actor,()=>{assert(['completed','failed'].includes(r.status)&&!r.held&&!this.active.has(r.id),'BUSY','Previous native turn must be confirmed finished before rework',409);const chain=this.store.list('run').filter(x=>x.rootRunId===r.rootRunId);assert(chain.reduce((sum,x)=>sum+x.round,0)<8,'LIMIT_REACHED','Root round limit reached');const root=this.store.get('run',r.rootRunId);assert(root.deadlineAt>this.now(),'LIMIT_REACHED','Root deadline reached');this.participant(r.senderId);this.participant(r.recipientId);r.content=redact(text(p.content,'content'));r.round++;r.attemptId=id('attempt');r.status='queued';r.result=undefined;r.error=undefined;r.finishFingerprint=undefined;r.credentialHash=undefined;r.credential=undefined;r.lastAnswer=undefined;r.question=undefined;r.dependencyRunIds=[];this.saveRun(r);return publicRun(r)})
  }
  openQuestion(p,actor){keys(p,['runId','executionToken','kind','text','options','nativeRequestId']);const r=this.run(p.runId,actor);this.authorizeExecution(r,p,actor);assert(r.status==='running','INVALID_STATE','Task is not running');assert(['clarification','approval'].includes(p.kind),'INVALID_ARGUMENT','Unknown question kind');if(p.kind==='approval')assert(r.managed,'FORBIDDEN','Only native adapter may request user approval',403)
    const q={id:id('question'),runId:r.id,kind:p.kind,text:redact(text(p.text,'text',10000)),...(p.options?{options:this.peers(p.options)}:{}),status:'open',createdAt:this.now(),attemptId:r.attemptId};this.store.put('question',q);r.status=p.kind==='approval'?'waiting_approval':'waiting_question';r.question=q;this.saveRun(r);return q
  }
  answerQuestion(p,actor){keys(p,['questionId','answer','approved']);const q=this.store.get('question',p.questionId);assert(q&&q.status==='open','NOT_FOUND','Question is not open',404);const r=this.run(q.runId,actor);assert(q.attemptId===r.attemptId&&!TERMINAL.has(r.status),'STALE_QUESTION','Question belongs to an old execution',409)
    if(q.kind==='approval'){this.admin(actor);assert(typeof p.approved==='boolean','INVALID_ARGUMENT','Approval must be a user decision');q.approved=p.approved}else{assert(actor.admin||r.senderId===actor.participantId,'FORBIDDEN','Only origin or local user may answer',403);assert(p.approved===undefined,'FORBIDDEN','Clarification is not approval',403);q.answer=text(p.answer,'answer',10000)}
    q.status='answered';q.answeredAt=this.now();this.store.put('question',q);r.lastAnswer={questionId:q.id,...(q.kind==='approval'?{approved:q.approved}:{answer:q.answer})};r.question=undefined
    if(r.managed){r.status='waiting_question'}else{r.status='queued';r.held=false;r.credential=undefined;r.credentialHash=undefined}
    this.saveRun(r);return {accepted:true}
  }
  cancelQuestions(runId){for(const q of this.store.list('question'))if(q.runId===runId&&q.status==='open'){q.status='cancelled';this.store.put('question',q)}}
  refreshDependencies(){for(const r of this.store.list('run'))if(r.status==='waiting_dependency'&&!r.managed){const deps=r.dependencyRunIds.map(d=>this.store.get('run',d));if(deps.some(d=>d&&['failed','cancelled'].includes(d.status))){r.status='failed';r.error='A dependency did not complete';r.held=false;this.saveRun(r)}else if(deps.every(d=>d?.status==='completed')){r.status='queued';this.saveRun(r)}}}
  async wait(p,actor){
    keys(p,['runId','timeoutMs','parentRunId','executionToken']);let target=this.run(p.runId,actor);const timeout=number(p.timeoutMs,25000,0,25000);let parent
    if(p.parentRunId){parent=this.run(p.parentRunId,actor);this.authorizeExecution(parent,p,actor);assert(parent.id!==target.id&&target.rootRunId===parent.rootRunId,'CYCLE','Wait must target a descendant in the current root');let cursor=target;let descendant=false;while(cursor?.parentRunId){if(cursor.parentRunId===parent.id){descendant=true;break}cursor=this.store.get('run',cursor.parentRunId)}assert(descendant,'CYCLE','Cannot wait on an ancestor or unrelated branch')
      if(!TERMINAL.has(target.status))this.store.tx(()=>{const r=this.run(parent.id,actor);this.authorizeExecution(r,p,actor);r.status='waiting_dependency';r.dependencyRunIds=[...new Set([...r.dependencyRunIds,target.id])];this.saveRun(r)})
      this.schedule()
    }
    const started=this.now(),revision=target.revision
    while(!this.closed&&this.now()-started<timeout){target=this.run(p.runId,actor);if(TERMINAL.has(target.status)||INPUT.has(target.status)||(!parent&&target.revision!==revision))break;await this.waitChange(Math.min(250,timeout-(this.now()-started)))}
    target=this.run(p.runId,actor)
    if(parent&&(TERMINAL.has(target.status)||target.status==='waiting_question'&&target.question?.kind==='clarification')){const fresh=this.run(parent.id,actor);this.authorizeExecution(fresh,p,actor);await this.reacquire(fresh.id,p.executionToken,undefined,target.status==='waiting_question'?target.id:undefined)}
    return publicRun(target)
  }
  waitChange(ms=100,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(Object.assign(new Error('Execution aborted'),{code:'ABORTED'}));let timer;const done=()=>{clearTimeout(timer);this.listeners.delete(done);signal?.removeEventListener('abort',abort);resolve()};const abort=()=>{clearTimeout(timer);this.listeners.delete(done);reject(Object.assign(new Error('Execution aborted'),{code:'ABORTED'}))};this.listeners.add(done);signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(done,Math.max(1,ms))})}
  async reacquire(rid,credential,signal,controlTarget){
    while(!this.closed){const r=this.store.get('run',rid);assert(r&&r.credentialHash===hash(credential)&&!['cancel_requested','cancelled','interrupted','uncertain'].includes(r.status),'STALE_EXECUTION','Execution was stopped',409)
      if(r.status==='running')return
      if(r.dependencyRunIds.some(d=>{const child=this.store.get('run',d);return child&&!TERMINAL.has(child.status)&&!(d===controlTarget&&child.status==='waiting_question'&&child.question?.kind==='clarification'&&child.senderId===r.recipientId)})){await this.waitChange(100,signal);continue}
      if(this.capacity()<this.maxConcurrent){this.store.tx(()=>{const fresh=this.store.get('run',rid);assert(fresh.credentialHash===hash(credential),'STALE_EXECUTION','Execution changed');fresh.status='running';fresh.leaseUntil=this.now()+this.leaseMs;this.saveRun(fresh)});return}
      await this.waitChange(100,signal)
    }
    fail('UNAVAILABLE','Hub closed')
  }
  descendants(rid){const set=new Set([rid]);let changed=true;const all=this.store.list('run');while(changed){changed=false;for(const r of all)if(r.parentRunId&&set.has(r.parentRunId)&&!set.has(r.id)){set.add(r.id);changed=true}}return set}
  async cancel(p,actor){keys(p,['runId']);const root=this.run(p.runId,actor);assert(actor.admin||root.senderId===actor.participantId||root.recipientId===actor.participantId,'FORBIDDEN','Cannot cancel another participant’s task',403)
    const affected=this.descendants(root.id);this.store.tx(()=>{for(const rid of affected){const r=this.store.get('run',rid);if(TERMINAL.has(r.status))continue;this.cancelQuestions(rid);r.status=r.held?'cancel_requested':'cancelled';r.error='Cancellation requested';if(!r.held){r.credential=undefined;r.credentialHash=undefined}this.saveRun(r)}})
    await Promise.all([...affected].map(async rid=>{const live=this.active.get(rid);if(!live)return;let stopped=false;try{stopped=(await live.adapter.cancel(live.ctx))?.stopped===true}catch{}live.controller.abort();if(stopped&&!this.closed)this.store.tx(()=>{const r=this.store.get('run',rid);if(r?.status==='cancel_requested'){r.status='cancelled';r.held=false;r.credential=undefined;r.credentialHash=undefined;this.saveRun(r)}})}))
    if(!this.closed)this.store.tx(()=>this.refreshDependencies());this.schedule();return publicRun(this.store.get('run',root.id))
  }
  async revoke(p,actor){this.admin(actor);keys(p,['id']);const entry=this.participant(p.id);this.store.tx(()=>{entry.revokedAt=this.now();entry.autoExecute=false;this.store.put('participant',entry);this.changed('participant.revoked',publicParticipant(entry),[entry.id])})
    for(const r of this.store.list('run'))if((r.recipientId===entry.id||r.senderId===entry.id)&&!TERMINAL.has(r.status))await this.cancel({runId:r.id},{admin:true})
    return publicParticipant(entry)
  }
  tick(){if(this.closed)return;const now=this.now();const candidates=this.store.list('run').filter(r=>!TERMINAL.has(r.status)&&((r.status==='running'&&!r.managed&&r.leaseUntil<=now)||r.deadlineAt<=now&&!['interrupted','uncertain','cancel_requested','paused'].includes(r.status)))
    if(!candidates.length)return
    this.store.tx(()=>{for(const candidate of candidates){const r=this.store.get('run',candidate.id);if(r.status==='running'&&!r.managed&&r.leaseUntil<=now){r.status='interrupted';r.error='Recipient lease expired; inspect progress before resetting';r.credential=undefined;r.credentialHash=undefined;this.cancelQuestions(r.id);this.saveRun(r)}else if(r.deadlineAt<=now&&!TERMINAL.has(r.status)&&!['interrupted','uncertain','cancel_requested','paused'].includes(r.status)){if(r.held){r.status='cancel_requested';r.error='Task deadline reached; native stop must be confirmed';queueMicrotask(()=>{if(!this.closed)void this.cancel({runId:r.id},{admin:true}).catch(()=>{})})}else{r.status='failed';r.error='Task expired before execution'}this.saveRun(r)}}this.refreshDependencies()})
  }
  schedule(){if(this.closed)return;if(this.pumping){this.pumpAgain=true;return}queueMicrotask(()=>{if(!this.closed)void this.pump()})}
  async pump(){if(this.pumping||this.closed)return;this.pumping=true
    try{do{this.pumpAgain=false;this.tick();const queued=this.store.list('run').filter(r=>r.status==='queued').sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))
      for(const r of queued){if(this.closed||!this.canClaim(r))continue;const p=this.store.get('participant',r.recipientId);if(!p||p.revokedAt||!p.autoExecute)continue;const adapter=this.adapters.get(p.provider);if(!adapter?.capabilities.automaticExecution||this.active.has(r.id))continue
        try{const claimed=this.store.tx(()=>this.claim(this.store.get('run',r.id),`auto:${r.attemptId}`,true));this.startDriver(r.id,claimed.executionToken,adapter,p)}catch(error){if(!['BUSY','NOT_FOUND'].includes(error.code))this.changed('adapter.error',{message:redact(error.message).slice(0,1000)},[p.id],r.id,r.threadId)}
      }
    }while(this.pumpAgain&&!this.closed)}finally{this.pumping=false}
  }
  startDriver(rid,credential,adapter,participant,recoverOnly=false){
    const controller=new AbortController();const initial=this.store.get('run',rid);const attemptId=initial.attemptId;const recipientActor={participantId:participant.id}
    const valid=()=>{const r=this.store.get('run',rid);assert(r&&r.attemptId===attemptId&&equalHash(r.credentialHash,hash(credential)),'STALE_EXECUTION','Execution changed',409);return r}
    const ctx={run:structuredClone(initial),participant:structuredClone(participant),signal:controller.signal,
      emit:event=>{if(this.closed)return;const r=valid();if(TERMINAL.has(r.status))return;this.changed('adapter.progress',{type:String(event.type??'progress').slice(0,80),text:redact(event.text??'').slice(0,4000)},[r.senderId,r.recipientId],r.id,r.threadId)},
      saveBinding:binding=>{if(this.closed)return;const r=valid();const safe={...(typeof binding.nativeSessionId==='string'?{nativeSessionId:binding.nativeSessionId}:{}),...(binding.nativeBinding?{nativeBinding:binding.nativeBinding}:{})};assert(JSON.stringify(safe).length<16000,'INVALID_OUTPUT','Native binding too large');Object.assign(r,safe);Object.assign(ctx.run,safe);this.store.tx(()=>{this.saveRun(r);this.store.put('binding',{id:participant.id,...safe})})},
      ask:async question=>{const q=await this.call('questions.ask',{runId:rid,executionToken:credential,...question},recipientActor);this.schedule();while(!controller.signal.aborted&&!this.closed){const fresh=this.store.get('question',q.id);if(fresh?.status==='answered'){await this.reacquire(rid,credential,controller.signal);return {answer:fresh.answer,approved:fresh.approved}}assert(fresh?.status==='open','STALE_QUESTION','Question cancelled',409);await this.waitChange(250,controller.signal)}fail('ABORTED','Question cancelled')},
      mcpConfig:{command:process.execPath,args:[path.join(ROOT,'bin/connect.mjs'),'mcp'],env:{UNAGENT_CONNECT_URL:this.url,UNAGENT_CONNECT_TOKEN:fs.readFileSync(path.join(this.stateDir,'credentials',participant.id+'.token'),'utf8').trim(),UNAGENT_CONNECT_RUN_ID:rid,UNAGENT_CONNECT_EXECUTION_TOKEN:credential}}
    }
    const live={controller,adapter,ctx,promise:null};this.active.set(rid,live)
    live.promise=Promise.resolve().then(()=>recoverOnly?adapter.recover(ctx):adapter.execute(ctx)).then(async result=>{
      if(this.closed)return;const r=valid()
      if(r.status==='cancel_requested'){this.store.tx(()=>{r.status='cancelled';r.held=false;r.credential=undefined;r.credentialHash=undefined;this.saveRun(r);this.refreshDependencies()});return}
      assert(r.status==='running','INVALID_STATE','Adapter ended while a dependency or question was unresolved',409)
      if(result.nativeSessionId||result.nativeBinding)ctx.saveBinding(result)
      await this.call('runs.complete',{runId:rid,executionToken:credential,text:result.text,artifacts:result.artifacts??[]},recipientActor)
    }).catch(error=>{
      if(this.closed)return
      const r=this.store.get('run',rid);if(!r||r.attemptId!==attemptId||TERMINAL.has(r.status)||r.status==='interrupted')return
      this.store.tx(()=>{const unknown=error.code==='OUTCOME_UNKNOWN'||r.status==='cancel_requested'||controller.signal.aborted;r.status=unknown?(r.status==='cancel_requested'?'cancel_requested':'uncertain'):'failed';r.error=redact(error.message??String(error)).slice(0,4000);r.held=unknown;r.credential=undefined;r.credentialHash=undefined;this.cancelQuestions(r.id);this.saveRun(r);this.refreshDependencies()})
    }).finally(()=>{if(this.active.get(rid)===live)this.active.delete(rid);this.schedule()})
  }
  async recover(p,actor){
    this.admin(actor);keys(p,['runId']);const r=this.run(p.runId,actor)
    assert(['interrupted','uncertain','cancel_requested'].includes(r.status),'INVALID_STATE','Only unresolved native executions may be recovered')
    assert(!this.active.has(r.id),'BUSY','Native adapter is already supervising this task',409)
    const participant=this.participant(r.recipientId),adapter=this.adapters.get(participant.provider)
    assert(typeof adapter?.recover==='function'&&r.nativeBinding,'UNSUPPORTED','No persisted native execution can be queried')
    const occupied=this.capacity()-(r.held?1:0);assert(occupied<this.maxConcurrent,'BUSY','Wait for another running task before native recovery',409)
    const credential=token();this.store.tx(()=>{r.status='running';r.managed=true;r.held=true;r.credential=credential;r.credentialHash=hash(credential);r.error=undefined;r.deadlineAt=Math.max(r.deadlineAt,this.now()+60000);this.saveRun(r)})
    this.startDriver(r.id,credential,adapter,participant,true);return publicRun(r)
  }
  async close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);for(const live of this.active.values())live.controller.abort();this.store.tx(()=>{for(const r of this.store.list('run'))if(r.held&&!TERMINAL.has(r.status)){r.status='interrupted';r.error='Hub shut down; native outcome must be checked before re-execution';r.credential=undefined;r.credentialHash=undefined;this.saveRun(r)}});for(const fn of this.listeners)try{fn()}catch{}this.listeners.clear();this.store.close()}
}
export {HubError} from './security.mjs'
