import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createBridgeServer } from '../scripts/bridge-server.mjs'

test('CLI waits through dependency snapshots and makes a fresh query after clarification', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'unagent-cli-wait-'))
  const home = path.join(root, '.unagent', 'bridge')
  const bridge = createBridgeServer({ home, port: 0 })
  const listening = await bridge.listen()
  const base = `http://127.0.0.1:${listening.port}`
  let stopped = false
  let worker
  let hostToken = ''
  const sessionId = '0123456789abcdef0123456789abcdef'
  t.after(async () => { stopped = true; await bridge.close(); await worker?.catch(() => undefined); await rm(root, { recursive: true, force: true }) })
  const request = async (route, token, body) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(token && token === hostToken ? { 'X-UNagent-Bridge-Session': sessionId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return response.status === 204 ? null : response.json()
  }
  const hostCode = await request('/v1/admin/pair-codes', bridge.adminToken, { purpose: 'host' })
  const host = await request('/v1/hosts/pair', null, { code: hostCode.code, name: 'Wait test', registrationId: randomUUID() })
  hostToken = host.instanceToken
  const clientCode = await request(`/v1/instances/${host.instanceId}/pair-codes`, host.instanceToken, { purpose: 'client' })
  const client = await request('/v1/clients/register', null, { code: clientCode.code, name: 'wait-test', registrationId: randomUUID() })
  await writeFile(path.join(home, 'bridge-config.json'), JSON.stringify({ address: base }), { mode: 0o600 })
  await mkdir(path.join(home, 'clients'), { recursive: true, mode: 0o700 })
  const suffix = createHash('sha256').update('wait-test').digest('hex').slice(0, 8)
  await writeFile(path.join(home, 'clients', `wait-test-${suffix}.json`), JSON.stringify({ ...client, name: 'wait-test', instanceId: host.instanceId }), { mode: 0o600 })
  let calls = 0
  worker = (async () => {
    while (!stopped) {
      const delivery = await request(`/v1/instances/${host.instanceId}/next?waitMs=100`, host.instanceToken)
      if (!delivery || !delivery.callId) continue
      calls++
      const question = { questionId: 'outline-q', audience: 'origin', text: 'Which outline?' }
      const task = { id: 'task-one', rootTaskId: 'task-one', parentTaskId: null, origin: { kind: 'external' }, targetSessionId: 'session-one', dependencyTaskIds: [], createdAt: 1, updatedAt: calls, status: calls === 1 ? 'running' : calls === 2 ? 'waiting_origin' : 'completed' }
      const result = calls === 1
        ? { status: 'waiting_dependency', taskIds: ['task-one'], tasks: [task] }
        : calls === 2
          ? { status: 'waiting_origin', taskId: 'task-one', question, tasks: [{ ...task, question }] }
          : { status: 'completed', tasks: [{ ...task, result: 'done' }] }
      await request(`/v1/instances/${host.instanceId}/ack`, host.instanceToken, { callId: delivery.callId, ok: true, result })
    }
  })()
  await new Promise(resolve => setTimeout(resolve, 20))
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('scripts/unagent-connect.mjs'), 'wait', 'task-one', '--instance', host.instanceId, '--client', 'wait-test', '--timeout-ms', '5000'], { env: { ...process.env, NODE_ENV: 'test', UNAGENT_BRIDGE_TEST_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(err || out)))
  })
  assert.equal((await run()).status, 'waiting_origin')
  assert.equal(calls, 2)
  assert.equal((await run()).status, 'completed')
  assert.equal(calls, 3)
})
