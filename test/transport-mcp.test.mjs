import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createToolHandler, managedContext, TOOL_SPECS } from '../src/mcp.mjs'
import { Hub } from '../src/core/hub.mjs'
import { createHubServer } from '../src/server.mjs'

const names = TOOL_SPECS.map(t => t.name)
test('MCP exact methods, no admin tools or auth overrides, managed context is trusted only', async () => {
  assert.equal(names.some(n => /participants_(create|update|revoke)|reset|health/.test(n)), false)
  const calls = []
  const handler = createToolHandler({ call: async (m, p) => { calls.push([m,p]); return { status: 'completed' } } }, { env: { UNAGENT_CONNECT_RUN_ID: 'parent', UNAGENT_CONNECT_EXECUTION_TOKEN: 'trusted' } })
  await handler('connect_runs_submit', { recipientId: 'child', content: 'task', idempotencyKey: 'k' })
  assert.deepEqual(calls[0], ['runs.submit', { recipientId: 'child', content: 'task', idempotencyKey: 'k', parentRunId: 'parent', executionToken: 'trusted' }])
  await handler('connect_runs_wait', { runId: 'child' })
  assert.equal(calls[1][1].parentRunId, 'parent'); assert.equal(calls[1][1].executionToken, 'trusted')
  for (const args of [{ parentRunId: 'fake' }, { executionToken: 'fake' }, { token: 'fake' }, { senderId: 'fake' }]) await assert.rejects(handler('connect_runs_submit', { recipientId: 'child', content: 'task', idempotencyKey: 'k', ...args }))
  await assert.rejects(handler('connect_questions_answer', { questionId: 'q', answer: { approved: true } }), /审批/)
  await assert.rejects(handler('connect_participants_create', {}), /未开放/)
  assert.throws(() => managedContext({ UNAGENT_CONNECT_RUN_ID: 'x' }), /同时/)
})

test('MCP wait loops inside program through revisions and bounded RPCs until terminal/input/deadline/cancel', async () => {
  let count = 0, time = 0
  const handler = createToolHandler({ call: async (m, p) => { assert.equal(m, 'runs.wait'); assert.ok(p.timeoutMs <= 25000); count++; time += 25000; return { id: 'child', status: count < 4 ? 'running' : 'completed' } } }, { env: {}, now: () => time, pause: async () => {} })
  assert.equal((await handler('connect_runs_wait', { runId: 'child' })).status, 'completed')
  assert.equal(count, 4)
  for (const status of ['waiting_question', 'waiting_approval', 'uncertain', 'interrupted']) {
    let calls = 0
    const h = createToolHandler({ call: async () => { calls++; return { status } } }, {env:{}})
    assert.equal((await h('connect_runs_wait', {runId:'child'})).status,status);assert.equal(calls,1)
  }
  count = 0; time = 0
  const deadline = createToolHandler({ call: async () => { count++;time+=100;return {status:'running',deadlineAt:50} } }, { env:{},now:()=>time,pause:async()=>{} })
  await deadline('connect_runs_wait',{runId:'child'});assert.equal(count,1)
  const abort = new AbortController();abort.abort()
  await assert.rejects(handler('connect_runs_wait',{runId:'child'},{signal:abort.signal}), {name:'AbortError'})
})

test('real stdio MCP SDK advertises tools and delegates authenticated HTTP calls', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(),'connect-mcp-'))
  const hub = new Hub({stateDir,adapters:[]}), http = createHubServer({hub,stateDir,port:0})
  await http.listen()
  const p = await hub.call('participants.create',{name:'MCP',provider:'manual',workspace:stateDir},{admin:true})
  const tokenFile=path.join(stateDir,'participant.token');await writeFile(tokenFile,p.token,{mode:0o600})
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('bin/connect.mjs'),'mcp','--token-file',tokenFile,'--url',http.origin],stderr:'pipe',env:{PATH:process.env.PATH}})
  const client=new Client({name:'test',version:'1.0.0'})
  t.after(async()=>{await client.close();await http.close();await hub.close();await rm(stateDir,{recursive:true,force:true})})
  await client.connect(transport)
  assert.equal((await client.listTools()).tools.length,TOOL_SPECS.length)
  const result=await client.callTool({name:'connect_participants_list',arguments:{}})
  assert.equal(result.isError,undefined)
  const participants=JSON.parse(result.content[0].text)
  assert.equal(participants[0].id,p.participant.id)
  const denied=await client.callTool({name:'connect_participants_create',arguments:{}})
  assert.equal(denied.isError,true)
})
