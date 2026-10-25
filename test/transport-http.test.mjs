import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hub } from '../src/core/hub.mjs'
import { createHubServer, MAX_BODY_BYTES } from '../src/server.mjs'
import { createClient } from '../src/client.mjs'

async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'connect-http-'))
  const hub = new Hub({ stateDir, adapters: options.adapters || [] })
  const server = createHubServer({ hub, stateDir, port: 0, ...options })
  await server.listen()
  t.after(async () => { await server.close(); await hub.close(); await rm(stateDir, { recursive: true, force: true }) })
  const url = server.origin
  const post = async (route, data, headers = {}) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof data === 'string' ? data : JSON.stringify(data) })
  const login = await post('/v1/login', { token: hub.adminToken }, { Origin: url })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const admin = async (method, params = {}) => {
    const response = await post('/v1/rpc', { method, params }, { Cookie: cookie, Origin: url })
    const data = await response.json()
    assert.equal(response.status, 200, JSON.stringify(data)); assert.equal(data.ok, true, JSON.stringify(data))
    return data.result
  }
  return { hub, server, stateDir, url, post, cookie, login, admin }
}

test('HTTP exact host/origin, body bound, login cookie and CSRF; async calls remain awaited', async t => {
  const f = await fixture(t)
  assert.match(f.login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  assert.deepEqual(await (await fetch(f.url + '/v1/health')).json(), { version: '0.2.1' })
  const badHost = await new Promise((resolve, reject) => {
    const req = http.get(f.url + '/', {headers:{Host:'localhost:' + new URL(f.url).port}},res=>{res.resume();resolve(res.statusCode)})
    req.on('error',reject)
  })
  assert.equal(badHost, 403)
  assert.equal((await f.post('/v1/rpc', { method: 'system.status', params: {} }, { Cookie: f.cookie })).status, 403)
  assert.equal((await f.post('/v1/rpc', { method: 'system.status', params: {} }, { Cookie: f.cookie, Origin: 'http://evil.example' })).status, 403)
  assert.equal((await f.post('/v1/login', { token: f.hub.adminToken }, { Origin: 'null' })).status, 403)
  assert.equal((await f.post('/v1/login', { token: f.hub.adminToken })).status, 403)
  assert.equal((await f.post('/v1/rpc', { method: 'system.status', params: {} })).status, 401)
  assert.equal((await f.post('/v1/rpc', 'x'.repeat(MAX_BODY_BYTES + 1), { Cookie: f.cookie, Origin: f.url })).status, 413)
  assert.equal((await f.post('/v1/rpc', '{', { Cookie: f.cookie, Origin: f.url })).status, 400)
  const original = f.hub.call.bind(f.hub)
  f.hub.call = async (...args) => { await new Promise(r => setTimeout(r, 10)); return await original(...args) }
  assert.equal((await f.admin('system.status')).version, '0.2.1')
  assert.equal(JSON.parse(await readFile(path.join(f.stateDir, 'connection.json'), 'utf8')).url, f.url)
  assert.equal((await stat(path.join(f.stateDir, 'connection.json'))).mode & 0o777, 0o600)
  assert.equal(f.hub.url, f.url)
  // Chunked upload must enforce the same limit without trusting Content-Length.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.url + '/v1/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: f.cookie, Origin: f.url } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.write('x'.repeat(MAX_BODY_BYTES / 2)); req.end('x'.repeat(MAX_BODY_BYTES / 2 + 1))
  })
  assert.equal(status, 413)
})

test('HTTP real participant identity, management isolation, messages/tasks and credential fencing', async t => {
  const f = await fixture(t)
  const a = await f.admin('participants.create', { name: '甲', provider: 'manual', workspace: f.stateDir })
  const b = await f.admin('participants.create', { name: '乙', provider: 'manual', workspace: f.stateDir })
  assert.equal(a.participant.autoExecute, false)
  await f.admin('participants.update', { id: a.participant.id, allowedPeers: [b.participant.id] })
  const client = createClient({ url: f.url, token: a.token })
  await assert.rejects(client.call('participants.create', { name: '越权' }), { code: 'FORBIDDEN' })
  await assert.rejects(client.call('messages.send', { senderId: b.participant.id, recipientId: a.participant.id, content: '冒名', idempotencyKey: 'spoof' }), { code: 'FORBIDDEN' })
  const sent = await client.call('messages.send', { recipientId: b.participant.id, content: '<img src=x onerror=alert(1)>', idempotencyKey: 'message-1' })
  assert.equal(sent.message.senderId, a.participant.id)
  assert.equal((await f.admin('runs.list')).length, 0)
  const task = await client.call('runs.submit', { recipientId: b.participant.id, content: '工作', idempotencyKey: 'task-1' })
  assert.equal(task.status, 'queued')
  const list = await client.call('participants.list')
  assert.ok(list.every(p => !('config' in p) && !('tokenHash' in p)))
  const mcpAdmin = createClient({ url: f.url, token: f.hub.adminToken, mcp: true })
  await assert.rejects(mcpAdmin.call('participants.list'), { code: 'FORBIDDEN' })
  await f.admin('participants.revoke', { id: a.participant.id })
  await assert.rejects(client.call('participants.list'), { code: 'UNAUTHORIZED' })
})

test('SSE bounded connections, event cursor replay and unsubscribe on close', async t => {
  const f = await fixture(t, { maxStreams: 1 })
  const controller = new AbortController()
  t.after(() => controller.abort())
  const response = await fetch(f.url + '/v1/events/stream?after=0', { headers: { Cookie: f.cookie }, signal: controller.signal })
  assert.equal(response.status, 200)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let text = decoder.decode((await reader.read()).value)
  assert.match(text, /event: hub/)
  assert.equal((await fetch(f.url + '/v1/events/stream', { headers: { Cookie: f.cookie } })).status, 429)
  await f.admin('participants.create', { name: '事件', provider: 'manual', workspace: f.stateDir })
  while (!text.includes('participant.created')) text += decoder.decode((await reader.read()).value)
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]))
  const after = ids.at(-1)
  const replay = await fetch(f.url + '/v1/events?after=' + after, { headers: { Cookie: f.cookie } })
  const batch = (await replay.json()).result
  assert.ok(batch.events.every(e => e.id > after))
  assert.equal((await fetch(f.url + '/v1/events?after=-1', { headers: { Cookie: f.cookie } })).status, 400)
  await reader.cancel(); controller.abort()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(f.hub.listeners.size, 0)
})

test('real HTTP management creates/edits native config, answers approval top-level and reworks only stopped successful/failed runs', async t => {
  const f = await fixture(t)
  const config = { sessionId: 'native-idle-session', gatewayDir: f.stateDir }
  const a = await f.admin('participants.create', { name: '发起者', provider: 'manual', workspace: f.stateDir })
  const b = await f.admin('participants.create', { name: '原生配置', provider: 'codex', workspace: f.stateDir, config })
  assert.equal(b.participant.autoExecute, false)
  let state = await f.admin('system.status')
  assert.deepEqual(state.participants.find(p => p.id === b.participant.id).config, config)
  const updated = { sessionId: 'changed-idle-session', projectMode: 'dedicated' }
  await f.admin('participants.update', { id: b.participant.id, name: '原生配置更新', config: updated })
  state = await f.admin('system.status')
  assert.equal(state.participants.find(p => p.id === b.participant.id).name, '原生配置更新')
  assert.deepEqual(state.participants.find(p => p.id === b.participant.id).config, updated)
  const adapter = { id: 'codex', capabilities: { automaticExecution: true }, health: async () => ({state:'available'}), cancel: async () => ({stopped:true}), execute: async ctx => {
    const decision = await ctx.ask({kind:'approval',text:'允许本次测试操作？'})
    return {text:decision.approved?'实际执行结果':'已拒绝'}
  } }
  f.hub.adapters.set('codex', adapter)
  await f.admin('participants.update', {id:b.participant.id,autoExecute:true})
  const run = await f.admin('runs.submit', { senderId: a.participant.id, recipientId: b.participant.id, content: '审批和结果接线', idempotencyKey: 'approval-run' })
  let waiting
  for(let i=0;i<100;i++){waiting=await f.admin('runs.get',{runId:run.id});if(waiting.status==='waiting_approval')break;await new Promise(r=>setTimeout(r,5))}
  assert.equal(waiting.status,'waiting_approval')
  const answer = await f.admin('questions.answer', {questionId:waiting.question.id,approved:true})
  assert.ok(answer)
  let complete
  for(let i=0;i<100;i++){complete=await f.admin('runs.get',{runId:run.id});if(complete.status==='completed')break;await new Promise(r=>setTimeout(r,5))}
  assert.equal(complete.status,'completed');assert.equal(complete.result.text,'实际执行结果')
  await f.admin('participants.update', {id:b.participant.id,autoExecute:false})
  const rework = await f.admin('runs.rework', { runId: run.id, content: '复核结果', idempotencyKey: 'approval-rework' })
  assert.equal(rework.id, run.id); assert.equal(rework.round, 2)
  assert.equal(rework.threadId, run.threadId)
  await f.admin('runs.cancel', { runId: run.id })
  const refused = await f.post('/v1/rpc', { method: 'runs.rework', params: { runId: run.id, content: '不允许重做取消任务', idempotencyKey: 'after-cancel' } }, { Cookie: f.cookie, Origin: f.url })
  assert.equal(refused.status, 409)
})
test('Obsidian explicit origin supports participant RPC preflight but never admin or cookies',async t=>{
 const f=await fixture(t);const participant=await f.admin('participants.create',{name:'plugin',provider:'manual',workspace:f.stateDir})
 const preflight=await fetch(f.url+'/v1/rpc',{method:'OPTIONS',headers:{Origin:'app://obsidian.md','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}})
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'app://obsidian.md')
 const result=await f.post('/v1/rpc',{method:'participants.list',params:{}},{Origin:'app://obsidian.md',Authorization:'Bearer '+participant.token,'Sec-Fetch-Site':'cross-site'});assert.equal(result.status,200)
 assert.equal((await f.post('/v1/rpc',{method:'participants.list',params:{}},{Origin:'app://obsidian.md',Cookie:f.cookie})).status,401)
 assert.equal((await f.post('/v1/rpc',{method:'participants.list',params:{}},{Origin:'app://obsidian.md',Authorization:'Bearer '+f.hub.adminToken})).status,403)
})
