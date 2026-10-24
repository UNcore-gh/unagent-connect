import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createBridgeServer } from '../scripts/bridge-server.mjs'

const cli = fileURLToPath(new URL('../scripts/unagent-connect.mjs', import.meta.url))

for (const method of ['inbox.complete', 'inbox.fail']) {
  test(`real CLI ${method} injects the business key, reuses acknowledgements and rejects conflicting keys`, { timeout: 15000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'unagent-cli-inbox-'))
    const home = path.join(root, '.unagent', 'bridge')
    const bridge = createBridgeServer({ home, port: 0 })
    let stopped = false
    let worker
    let workerError
    const children = new Set()
    t.after(async () => {
      stopped = true
      for (const child of children) child.kill('SIGKILL')
      await bridge.close()
      await worker
      await rm(root, { recursive: true, force: true })
      if (workerError) throw workerError
    })
    const { port } = await bridge.listen()
    const base = `http://127.0.0.1:${port}`
    const sessionId = randomUUID().replaceAll('-', '')
    let hostToken
    const request = async (route, token, body) => {
      const response = await fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(token && token === hostToken ? { 'X-UNagent-Bridge-Session': sessionId } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (response.status === 204) return null
      const result = await response.json()
      assert.equal(response.ok, true, JSON.stringify(result))
      return result
    }
    const hostCode = await request('/v1/admin/pair-codes', bridge.adminToken, { purpose: 'host' })
    const host = await request('/v1/hosts/pair', null, { code: hostCode.code, name: 'Synthetic inbox host', registrationId: randomUUID() })
    hostToken = host.instanceToken
    const clientCode = await request(`/v1/instances/${host.instanceId}/pair-codes`, hostToken, { purpose: 'client' })
    const name = 'inbox-test'
    const client = await request('/v1/clients/register', null, { code: clientCode.code, name, registrationId: randomUUID() })
    await writeFile(path.join(home, 'bridge-config.json'), JSON.stringify({ address: base }), { mode: 0o600 })
    await mkdir(path.join(home, 'clients'), { recursive: true, mode: 0o700 })
    const suffix = createHash('sha256').update(name).digest('hex').slice(0, 8)
    await writeFile(path.join(home, 'clients', `${name}-${suffix}.json`), JSON.stringify({ ...client, name, instanceId: host.instanceId }), { mode: 0o600 })
    const deliveries = []
    const ready = request(`/v1/instances/${host.instanceId}/next?waitMs=100`, hostToken)
    worker = (async () => {
      let delivery = await ready
      while (!stopped) {
        if (delivery?.callId) {
          deliveries.push(delivery)
          await request(`/v1/instances/${host.instanceId}/ack`, hostToken, {
            callId: delivery.callId, ok: true,
            result: { id: delivery.params.taskId, status: method === 'inbox.complete' ? 'completed' : 'failed' },
          })
        }
        if (!stopped) delivery = await request(`/v1/instances/${host.instanceId}/next?waitMs=100`, hostToken)
      }
    })().catch(error => { if (!stopped) workerError = error })
    // Finish one poll to establish that the real bridge sees this host online.
    await ready
    const run = (idem, params) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'call', method, '--instance', host.instanceId, '--client', name, '--idem', idem, '--params-file', '-', '--timeout-ms', '3000'], {
        env: { ...process.env, NODE_ENV: 'test', UNAGENT_BRIDGE_TEST_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.add(child)
      let out = '', err = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.stderr.on('data', chunk => { err += chunk })
      child.once('error', reject)
      child.once('close', code => { children.delete(child); resolve({ code, out, err }) })
      child.stdin.on('error', reject)
      child.stdin.end(JSON.stringify(params))
    })
    const params = { taskId: 'synthetic-task', executionToken: 'synthetic-execution-token', ...(method === 'inbox.complete' ? { result: 'done' } : { error: 'synthetic failure' }) }
    const first = await run('implicit-key', params)
    assert.equal(first.code, 0, first.err || first.out)
    const receipt = JSON.parse(first.out)
    assert.equal(receipt.status, 'completed')
    assert.equal(receipt.result.status, method === 'inbox.complete' ? 'completed' : 'failed')
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].method, method)
    assert.deepEqual(deliveries[0].params, { ...params, idempotencyKey: 'implicit-key' })
    const retry = await run('implicit-key', params)
    assert.equal(retry.code, 0, retry.err || retry.out)
    assert.equal(JSON.parse(retry.out).callId, receipt.callId)
    assert.equal(deliveries.length, 1, 'retry must reuse the receipt without delivering twice')
    const explicit = await run('explicit-key', { ...params, idempotencyKey: 'explicit-key' })
    assert.equal(explicit.code, 0, explicit.err || explicit.out)
    assert.equal(deliveries.length, 2)
    assert.deepEqual(deliveries[1].params, { ...params, idempotencyKey: 'explicit-key' })
    const conflict = await run('outer-key', { ...params, idempotencyKey: 'different-inner-key' })
    assert.notEqual(conflict.code, 0)
    assert.match(conflict.err + conflict.out, /IDEMPOTENCY_CONFLICT/)
    assert.equal(deliveries.length, 2, 'conflicting keys must never reach the host')
  })
}
