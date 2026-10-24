import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { createBridgeServer, MAX_BODY_BYTES, ONLINE_WINDOW_MS, TRANSPORT_TTL_MS } from '../scripts/bridge-server.mjs'

async function temporaryHome() {
  const root = await mkdtemp(path.join(tmpdir(), 'unagent-bridge-contract-'))
  return { root, home: path.join(root, '.unagent', 'bridge') }
}

async function request(base, route, { method = 'GET', token, sessionId, body, headers = {} } = {}) {
  const response = await fetch(new URL(route, base), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { 'X-UNagent-Bridge-Session': sessionId } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  let value = null
  if (response.status !== 204) {
    try { value = await response.json() } catch { value = null }
  }
  return { response, value }
}

async function start(home, options = {}) {
  const bridge = createBridgeServer({ home, port: 0, ...options })
  const address = await bridge.listen()
  return { bridge, base: `http://127.0.0.1:${address.port}` }
}

async function pairFixture(base, adminToken) {
  const codeResult = await request(base, '/v1/admin/pair-codes', {
    method: 'POST', token: adminToken, body: { purpose: 'host' },
  })
  assert.equal(codeResult.response.status, 201)
  const code = codeResult.value.code
  const registrationId = '12345678-1234-1234-1234-123456789abc'
  const hostResult = await request(base, '/v1/hosts/pair', {
    method: 'POST', body: { code, name: 'Test vault', registrationId },
  })
  assert.equal(hostResult.response.status, 201)
  const duplicatePair = await request(base, '/v1/hosts/pair', {
    method: 'POST', body: { code, name: 'Test vault', registrationId },
  })
  assert.equal(duplicatePair.value.instanceToken, hostResult.value.instanceToken)

  const clientCodeResult = await request(
    base,
    `/v1/instances/${hostResult.value.instanceId}/pair-codes`,
    { method: 'POST', token: hostResult.value.instanceToken, body: { purpose: 'client' } },
  )
  assert.equal(clientCodeResult.response.status, 201)
  const clientRegistrationId = 'abcdefab-cdef-abcd-efab-cdefabcdefab'
  const clientResult = await request(base, '/v1/clients/register', {
    method: 'POST',
    body: { code: clientCodeResult.value.code, name: 'contract client', registrationId: clientRegistrationId },
  })
  assert.equal(clientResult.response.status, 201)
  const clientRetry = await request(base, '/v1/clients/register', {
    method: 'POST',
    body: { code: clientCodeResult.value.code, name: 'contract client', registrationId: clientRegistrationId },
  })
  assert.equal(clientRetry.value.clientToken, clientResult.value.clientToken)

  return {
    instance: hostResult.value,
    client: clientResult.value,
    sessionId: '0123456789abcdef0123456789abcdef',
    nextSessionId: 'fedcba9876543210fedcba9876543210',
  }
}

test('v1 authenticates distinct roles, acknowledges business work, and never persists call content', async (t) => {
  const { root, home } = await temporaryHome()
  let clock = Date.now()
  const { bridge, base } = await start(home, { now: () => clock })
  t.after(async () => {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  })
  const { instance, client, sessionId } = await pairFixture(base, bridge.adminToken)

  const deniedAdmin = await request(base, '/v1/admin/instances', { token: client.clientToken })
  assert.equal(deniedAdmin.response.status, 401)
  const badOrigin = await request(base, '/v1/health', { headers: { Origin: 'https://ordinary.example' } })
  assert.equal(badOrigin.response.status, 403)
  const appOrigin = await request(base, '/v1/health', { headers: { Origin: 'app://obsidian.md' } })
  assert.equal(appOrigin.response.status, 200)
  assert.equal(appOrigin.response.headers.get('access-control-allow-origin'), 'app://obsidian.md')

  const pulse = await request(base, `/v1/instances/${instance.instanceId}/next?waitMs=0`, { token: instance.instanceToken, sessionId })
  assert.equal(pulse.response.status, 204)
  const createWithoutBusinessKey = await request(base, '/v1/calls', {
    method: 'POST', token: client.clientToken,
    body: { instanceId: instance.instanceId, method: 'sessions.create', params: { title: 'Contract session' }, idempotencyKey: 'session-create-1' },
  })
  assert.equal(createWithoutBusinessKey.response.status, 202)
  const cancelCreate = await request(base, `/v1/calls/${createWithoutBusinessKey.value.callId}/cancel`, {
    method: 'POST', token: client.clientToken,
  })
  assert.equal(cancelCreate.value.status, 'cancelled')
  const sendWithoutBusinessKey = await request(base, '/v1/calls', {
    method: 'POST', token: client.clientToken,
    body: { instanceId: instance.instanceId, method: 'sessions.send', params: { message: 'missing stable key' }, idempotencyKey: 'send-without-key' },
  })
  assert.equal(sendWithoutBusinessKey.response.status, 400)
  const body = {
    instanceId: instance.instanceId,
    method: 'sessions.send',
    params: { message: 'secret business payload', idempotencyKey: 'business-send-42' },
    idempotencyKey: 'business-send-42',
    clientId: 'forged identity must be ignored',
  }
  const queued = await request(base, '/v1/calls', { method: 'POST', token: client.clientToken, body })
  assert.equal(queued.response.status, 202)
  assert.equal(queued.value.businessAcked, false)
  const retried = await request(base, '/v1/calls', { method: 'POST', token: client.clientToken, body })
  assert.equal(retried.value.callId, queued.value.callId)
  const conflict = await request(base, '/v1/calls', {
    method: 'POST', token: client.clientToken,
    body: { ...body, params: { message: 'changed', idempotencyKey: 'business-send-42' } },
  })
  assert.equal(conflict.response.status, 409)

  const delivered = await request(base, `/v1/instances/${instance.instanceId}/next?waitMs=0`, { token: instance.instanceToken, sessionId })
  assert.equal(delivered.response.status, 200)
  assert.equal(delivered.value.client.clientId, client.clientId)
  assert.equal(delivered.value.client.clientName, 'contract client')
  assert.equal(delivered.value.params.message, 'secret business payload')
  const acked = await request(base, `/v1/instances/${instance.instanceId}/ack`, {
    method: 'POST', token: instance.instanceToken,
    body: { callId: delivered.value.callId, ok: true, result: { taskId: 'task-contract-42', detail: 'secret business result' } },
  })
  assert.equal(acked.value.status, 'completed')
  const result = await request(base, `/v1/calls/${queued.value.callId}`, { token: client.clientToken })
  assert.equal(result.value.businessAcked, true)
  assert.equal(result.value.result.taskId, 'task-contract-42')

  const unknown = await request(base, '/v1/calls', {
    method: 'POST', token: client.clientToken,
    body: { instanceId: instance.instanceId, method: 'secrets.read', params: {}, idempotencyKey: 'bad-method' },
  })
  assert.equal(unknown.response.status, 404)
  assert.equal(unknown.value.error.code, 'METHOD_NOT_FOUND')

  const statePath = path.join(home, 'bridge-state.json')
  const persistedState = await readFile(statePath, 'utf8')
  assert.equal(persistedState.includes('secret business payload'), false)
  assert.equal(persistedState.includes('secret business result'), false)
  assert.equal(persistedState.includes('task-contract-42'), false)
  assert.equal(JSON.parse(persistedState).calls, undefined)
  const stateFile = await stat(statePath)
  assert.equal(stateFile.mode & 0o777, 0o600)

  clock += 46_000
  const completedRetryWhileOffline = await request(base, '/v1/calls', {
    method: 'POST', token: client.clientToken, body,
  })
  assert.equal(completedRetryWhileOffline.response.status, 200)
  assert.equal(completedRetryWhileOffline.value.result.taskId, 'task-contract-42')
  const offline = await request(base, '/v1/calls', {
    method: 'POST', token: client.clientToken,
    body: { instanceId: instance.instanceId, method: 'sessions.list', params: {}, idempotencyKey: 'offline-check' },
  })
  assert.equal(offline.response.status, 503)
  assert.equal(offline.value.error.code, 'INSTANCE_OFFLINE')

  const oversized = await request(base, '/v1/clients/register', {
    method: 'POST', token: client.clientToken,
    body: { filler: 'x'.repeat(MAX_BODY_BYTES) },
  })
  assert.equal(oversized.response.status, 413)
  assert.equal(oversized.value.error.code, 'PAYLOAD_TOO_LARGE')

  const revoked = await request(
    base,
    `/v1/instances/${instance.instanceId}/clients/${client.clientId}`,
    { method: 'DELETE', token: instance.instanceToken },
  )
  assert.equal(revoked.value.revoked, true)
  const revokedClient = await request(base, '/v1/admin/instances', { token: client.clientToken })
  assert.equal(revokedClient.response.status, 401)
  const unpaired = await request(base, `/v1/instances/${instance.instanceId}`, {
    method: 'DELETE', token: instance.instanceToken,
  })
  assert.equal(unpaired.value.unpaired, true)
})

test('business task recovery survives bridge restart and transport cache expires without persisted bodies', async (t) => {
  const { root, home } = await temporaryHome()
  let clock = Date.now()
  let current = await start(home, { now: () => clock })
  t.after(async () => {
    await current.bridge.close()
    await rm(root, { recursive: true, force: true })
  })
  const fixture = await pairFixture(current.base, current.bridge.adminToken)
  const secondClientCode = await request(
    current.base,
    `/v1/instances/${fixture.instance.instanceId}/pair-codes`,
    { method: 'POST', token: fixture.instance.instanceToken, body: { purpose: 'client' } },
  )
  const secondClient = await request(current.base, '/v1/clients/register', {
    method: 'POST',
    body: {
      code: secondClientCode.value.code,
      name: 'other client',
      registrationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    },
  })
  assert.equal(secondClient.response.status, 201)
  await request(current.base, `/v1/instances/${fixture.instance.instanceId}/next?waitMs=0`, { token: fixture.instance.instanceToken, sessionId: fixture.sessionId })

  const params = { message: 'persistent task content', idempotencyKey: 'stable-task-777' }
  const first = await request(current.base, '/v1/calls', {
    method: 'POST', token: fixture.client.clientToken,
    body: { instanceId: fixture.instance.instanceId, method: 'sessions.send', params, idempotencyKey: 'stable-task-777' },
  })
  const firstDelivery = await request(current.base, `/v1/instances/${fixture.instance.instanceId}/next?waitMs=0`, { token: fixture.instance.instanceToken, sessionId: fixture.sessionId })
  assert.equal(firstDelivery.value.params.idempotencyKey, 'stable-task-777')
  await request(current.base, `/v1/instances/${fixture.instance.instanceId}/ack`, {
    method: 'POST', token: fixture.instance.instanceToken,
    body: { callId: firstDelivery.value.callId, ok: true, result: { taskId: 'task-777' } },
  })
  const firstResult = await request(current.base, `/v1/calls/${first.value.callId}`, { token: fixture.client.clientToken })
  assert.equal(firstResult.value.result.taskId, 'task-777')
  await current.bridge.close()

  current = await start(home, { now: () => clock })
  const oldTransport = await request(current.base, `/v1/calls/${first.value.callId}`, { token: fixture.client.clientToken })
  assert.equal(oldTransport.response.status, 404)
  await request(current.base, `/v1/instances/${fixture.instance.instanceId}/next?waitMs=0`, { token: fixture.instance.instanceToken, sessionId: fixture.nextSessionId })

  const repeated = await request(current.base, '/v1/calls', {
    method: 'POST', token: fixture.client.clientToken,
    body: { instanceId: fixture.instance.instanceId, method: 'sessions.send', params, idempotencyKey: 'stable-task-777' },
  })
  const repeatedDelivery = await request(current.base, `/v1/instances/${fixture.instance.instanceId}/next?waitMs=0`, { token: fixture.instance.instanceToken, sessionId: fixture.nextSessionId })
  assert.equal(repeatedDelivery.value.params.idempotencyKey, 'stable-task-777')
  // The plugin business layer recognizes the same stable key and returns its
  // existing task id; Bridge itself has not retained the task or result.
  await request(current.base, `/v1/instances/${fixture.instance.instanceId}/ack`, {
    method: 'POST', token: fixture.instance.instanceToken,
    body: { callId: repeatedDelivery.value.callId, ok: true, result: { taskId: 'task-777' } },
  })
  const repeatedResult = await request(current.base, `/v1/calls/${repeated.value.callId}`, { token: fixture.client.clientToken })
  assert.equal(repeatedResult.value.result.taskId, 'task-777')

  clock += TRANSPORT_TTL_MS + 1
  const expired = await request(current.base, `/v1/calls/${repeated.value.callId}`, { token: fixture.client.clientToken })
  assert.equal(expired.value.status, 'expired')
  const crossClientExpired = await request(current.base, `/v1/calls/${repeated.value.callId}`, { token: secondClient.value.clientToken })
  assert.equal(crossClientExpired.response.status, 404)
  const persisted = await readFile(path.join(home, 'bridge-state.json'), 'utf8')
  assert.equal(persisted.includes('persistent task content'), false)
  assert.equal(persisted.includes('task-777'), false)
})

test('explicit disconnect is immediate, cancels queued delivery, and reconnect does not replay it', async (t) => {
  const { root, home } = await temporaryHome()
  const { bridge, base } = await start(home)
  t.after(async () => {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  })
  const fixture = await pairFixture(base, bridge.adminToken)
  const pulse = await request(base, `/v1/instances/${fixture.instance.instanceId}/next?waitMs=0`, {
    token: fixture.instance.instanceToken,
    sessionId: fixture.sessionId,
  })
  assert.equal(pulse.response.status, 204)

  const first = await request(base, '/v1/calls', {
    method: 'POST', token: fixture.client.clientToken,
    body: { instanceId: fixture.instance.instanceId, method: 'sessions.list', params: {}, idempotencyKey: 'disable-check' },
  })
  assert.equal(first.response.status, 202)
  const disconnected = await request(base, `/v1/instances/${fixture.instance.instanceId}/disconnect`, {
    method: 'POST', token: fixture.instance.instanceToken, sessionId: fixture.sessionId,
  })
  assert.equal(disconnected.response.status, 200)
  assert.equal(disconnected.value.cancelledCalls, 1)

  const offline = await request(base, '/v1/calls', {
    method: 'POST', token: fixture.client.clientToken,
    body: { instanceId: fixture.instance.instanceId, method: 'sessions.list', params: {}, idempotencyKey: 'disabled-new-call' },
  })
  assert.equal(offline.response.status, 503)
  assert.equal(offline.value.error.code, 'INSTANCE_OFFLINE')

  const oldStatus = await request(base, `/v1/calls/${first.value.callId}`, { token: fixture.client.clientToken })
  assert.equal(oldStatus.value.status, 'cancelled')
  const reconnectPoll = await request(base, `/v1/instances/${fixture.instance.instanceId}/next?waitMs=0`, {
    token: fixture.instance.instanceToken,
    sessionId: fixture.nextSessionId,
  })
  assert.equal(reconnectPoll.response.status, 204)
  const afterReconnect = await request(base, `/v1/calls/${first.value.callId}`, { token: fixture.client.clientToken })
  assert.equal(afterReconnect.value.status, 'cancelled')

  const explicitRetry = await request(base, '/v1/calls', {
    method: 'POST', token: fixture.client.clientToken,
    body: { instanceId: fixture.instance.instanceId, method: 'sessions.list', params: {}, idempotencyKey: 'disable-check' },
  })
  assert.equal(explicitRetry.response.status, 202)
  assert.notEqual(explicitRetry.value.callId, first.value.callId)
})

test('disconnect received before a delayed poll fences that old session', async (t) => {
  const { root, home } = await temporaryHome()
  const { bridge, base } = await start(home)
  t.after(async () => {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  })
  const fixture = await pairFixture(base, bridge.adminToken)

  const disconnected = await request(base, `/v1/instances/${fixture.instance.instanceId}/disconnect`, {
    method: 'POST', token: fixture.instance.instanceToken, sessionId: fixture.sessionId,
  })
  assert.equal(disconnected.response.status, 200)

  const delayedPoll = await request(base, `/v1/instances/${fixture.instance.instanceId}/next?waitMs=0`, {
    token: fixture.instance.instanceToken, sessionId: fixture.sessionId,
  })
  assert.equal(delayedPoll.response.status, 409)
  assert.equal(delayedPoll.value.error.code, 'STALE_SESSION')

  const reconnect = await request(base, `/v1/instances/${fixture.instance.instanceId}/next?waitMs=0`, {
    token: fixture.instance.instanceToken, sessionId: fixture.nextSessionId,
  })
  assert.equal(reconnect.response.status, 204)
  const lateOldPoll = await request(base, `/v1/instances/${fixture.instance.instanceId}/next?waitMs=0`, {
    token: fixture.instance.instanceToken, sessionId: fixture.sessionId,
  })
  assert.equal(lateOldPoll.response.status, 409)
  const currentHeartbeat = await request(base, `/v1/instances/${fixture.instance.instanceId}/heartbeat`, {
    method: 'POST', token: fixture.instance.instanceToken, sessionId: fixture.nextSessionId,
  })
  assert.equal(currentHeartbeat.response.status, 200)
})

test('heartbeats renew the short online lease; an idle long poll cannot keep it online', async (t) => {
  const { root, home } = await temporaryHome()
  let clock = Date.now()
  const { bridge, base } = await start(home, { now: () => clock })
  t.after(async () => {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  })
  const fixture = await pairFixture(base, bridge.adminToken)
  const controller = new AbortController()
  const poll = fetch(new URL(`/v1/instances/${fixture.instance.instanceId}/next?waitMs=25000`, base), {
    headers: {
      Authorization: `Bearer ${fixture.instance.instanceToken}`,
      'X-UNagent-Bridge-Session': fixture.sessionId,
    },
    signal: controller.signal,
  })
  const onlineDeadline = Date.now() + 1_000
  let initialStatus
  do {
    initialStatus = await request(base, `/v1/instances/${fixture.instance.instanceId}/status`, {
      token: fixture.instance.instanceToken,
    })
    if (initialStatus.value.online) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < onlineDeadline)
  assert.equal(initialStatus.value.online, true)

  clock += ONLINE_WINDOW_MS - 1
  const heartbeat = await request(base, `/v1/instances/${fixture.instance.instanceId}/heartbeat`, {
    method: 'POST', token: fixture.instance.instanceToken, sessionId: fixture.sessionId,
  })
  assert.equal(heartbeat.response.status, 200)
  clock += ONLINE_WINDOW_MS - 1
  const renewedStatus = await request(base, `/v1/instances/${fixture.instance.instanceId}/status`, {
    token: fixture.instance.instanceToken,
  })
  assert.equal(renewedStatus.value.online, true)

  clock += 2
  const expiredStatus = await request(base, `/v1/instances/${fixture.instance.instanceId}/status`, {
    token: fixture.instance.instanceToken,
  })
  assert.equal(expiredStatus.value.online, false)

  const rejected = await request(base, '/v1/calls', {
    method: 'POST', token: fixture.client.clientToken,
    body: { instanceId: fixture.instance.instanceId, method: 'sessions.list', params: {}, idempotencyKey: 'expired-lease' },
  })
  assert.equal(rejected.response.status, 503)
  assert.equal(rejected.value.error.code, 'INSTANCE_OFFLINE')
  controller.abort()
  await poll.catch(() => undefined)
})

test('aborted long poll marks the plugin offline before another client call', async (t) => {
  const { root, home } = await temporaryHome()
  const { bridge, base } = await start(home)
  t.after(async () => {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  })
  const fixture = await pairFixture(base, bridge.adminToken)
  const controller = new AbortController()
  const poll = fetch(new URL(`/v1/instances/${fixture.instance.instanceId}/next?waitMs=25000`, base), {
    headers: {
      Authorization: `Bearer ${fixture.instance.instanceToken}`,
      'X-UNagent-Bridge-Session': fixture.sessionId,
    },
    signal: controller.signal,
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  controller.abort()
  await poll.catch(() => undefined)

  let status
  const deadline = Date.now() + 1_000
  do {
    status = await request(base, `/v1/instances/${fixture.instance.instanceId}/status`, { token: fixture.instance.instanceToken })
    if (!status.value.online) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  assert.equal(status.value.online, false)
  const rejected = await request(base, '/v1/calls', {
    method: 'POST', token: fixture.client.clientToken,
    body: { instanceId: fixture.instance.instanceId, method: 'sessions.list', params: {}, idempotencyKey: 'after-abort' },
  })
  assert.equal(rejected.response.status, 503)
})

test('startup removes legacy transport payloads from persisted state', async (t) => {
  const { root, home } = await temporaryHome()
  const initial = await start(home)
  let finalBridge = initial.bridge
  t.after(async () => {
    await finalBridge.close()
    await rm(root, { recursive: true, force: true })
  })
  await initial.bridge.close()
  const statePath = path.join(home, 'bridge-state.json')
  const legacy = JSON.parse(await readFile(statePath, 'utf8'))
  legacy.calls = [{ params: { prompt: 'legacy private prompt' }, result: 'legacy private result' }]
  legacy.idempotency = { 'client:instance:key': 'call-id' }
  await writeFile(statePath, JSON.stringify(legacy), { mode: 0o600 })

  const migrated = await start(home)
  finalBridge = migrated.bridge
  const safeState = await readFile(statePath, 'utf8')
  assert.equal(safeState.includes('legacy private prompt'), false)
  assert.equal(safeState.includes('legacy private result'), false)
  assert.equal(JSON.parse(safeState).calls, undefined)
  assert.equal(JSON.parse(safeState).idempotency, undefined)
})

test('CLI starts on an explicit port, creates pairing code, reports status, and stops cleanly', async (t) => {
  const { root, home } = await temporaryHome()
  t.after(() => rm(root, { recursive: true, force: true }))
  const port = await availablePort()
  const cli = path.resolve('scripts/unagent-connect.mjs')
  const env = { ...process.env, NODE_ENV: 'test', UNAGENT_BRIDGE_TEST_HOME: home }
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 15_000 })

  const started = run('start', '--port', String(port))
  assert.equal(started.status, 0, started.stderr)
  assert.equal(JSON.parse(started.stdout).address, `http://127.0.0.1:${port}`)
  const status = run('status')
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).running, true)
  const code = run('pair-code')
  assert.equal(code.status, 0, code.stderr)
  assert.equal(JSON.parse(code.stdout).code.length, 32)
  const stopped = run('stop')
  assert.equal(stopped.status, 0, stopped.stderr)
  assert.equal(JSON.parse(stopped.stdout).stopped, true)
})

for (const sendMethod of ['sessions.send', 'participants.send']) {
test(`CLI checks uncertain mutations after restart and safely replays ${sendMethod}`, async (t) => {
  const { root, home } = await temporaryHome()
  const port = await availablePort()
  const address = `http://127.0.0.1:${port}`
  let current = await start(home, { port })
  t.after(async () => {
    await current.bridge.close()
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(path.join(home, 'bridge-config.json'), JSON.stringify({ address }), { mode: 0o600 })
  const fixture = await pairFixture(current.base, current.bridge.adminToken)
  const profileName = 'stable-client'
  const profileHash = createHash('sha256').update(profileName).digest('hex').slice(0, 8)
  const profilePath = path.join(home, 'clients', `${profileName}-${profileHash}.json`)
  await mkdir(path.dirname(profilePath), { recursive: true, mode: 0o700 })
  await writeFile(profilePath, JSON.stringify({
    name: profileName,
    registrationId: 'abcdefab-cdef-abcd-efab-cdefabcdefab',
    clientId: fixture.client.clientId,
    clientToken: fixture.client.clientToken,
    instanceId: fixture.instance.instanceId,
  }), { mode: 0o600 })

  const cli = path.resolve('scripts/unagent-connect.mjs')
  const env = { ...process.env, NODE_ENV: 'test', UNAGENT_BRIDGE_TEST_HOME: home }
  const run = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (status) => {
      clearTimeout(timeout)
      resolve({ status, stdout, stderr })
    })
  })
  const poll = (sessionId) => {
    const controller = new AbortController()
    const promise = fetch(new URL(`/v1/instances/${fixture.instance.instanceId}/next?waitMs=25000`, current.base), {
      headers: {
        Authorization: `Bearer ${fixture.instance.instanceToken}`,
        'X-UNagent-Bridge-Session': sessionId,
      },
      signal: controller.signal,
    }).then(async (response) => ({ response, value: response.status === 204 ? null : await response.json() }))
      .catch((error) => ({ error }))
    return { controller, promise }
  }
  const waitOnline = async () => {
    const deadline = Date.now() + 1_000
    while (Date.now() < deadline) {
      const status = await request(current.base, `/v1/instances/${fixture.instance.instanceId}/status`, {
        token: fixture.instance.instanceToken,
      })
      if (status.value.online) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail('plugin host did not become online')
  }
  const callArgs = (method, idem) => [
    'call', method,
    '--instance', fixture.instance.instanceId,
    '--client', profileName,
    '--idem', idem,
    '--timeout-ms', '100',
  ]

  const conflictingParams = path.join(root, 'conflicting-params.json')
  await writeFile(conflictingParams, JSON.stringify({ idempotencyKey: 'different-inner-key' }))
  const conflict = await run(...callArgs(sendMethod, 'outer-key'), '--params-file', conflictingParams)
  assert.notEqual(conflict.status, 0)
  assert.equal(JSON.parse(conflict.stderr).error.code, 'IDEMPOTENCY_CONFLICT')

  const firstPoll = poll('11111111111111111111111111111111')
  await waitOnline()
  const createCall = await run(...callArgs('sessions.create', 'create-before-restart'))
  assert.equal(createCall.status, 2, createCall.stderr)
  assert.equal(JSON.parse(createCall.stdout).status, 'waiting')
  const deliveredCreate = await firstPoll.promise
  assert.equal(deliveredCreate.response.status, 200)

  const sendPoll = poll('22222222222222222222222222222222')
  await waitOnline()
  const cancelledMutation = await run(...callArgs('sessions.create', 'create-before-restart'))
  assert.equal(cancelledMutation.status, 2)
  assert.equal(JSON.parse(cancelledMutation.stderr).error.code, 'OUTCOME_UNKNOWN')

  const sendCall = await run(...callArgs(sendMethod, 'send-before-restart'))
  assert.equal(sendCall.status, 2, sendCall.stderr)
  const deliveredSendBeforeRestart = await sendPoll.promise
  assert.equal(deliveredSendBeforeRestart.response.status, 200)
  assert.equal(deliveredSendBeforeRestart.value.params.idempotencyKey, 'send-before-restart')

  await current.bridge.close()
  current = await start(home, { port })
  const afterRestartPoll = poll('33333333333333333333333333333333')
  await waitOnline()

  const refusedMutation = await run(...callArgs('sessions.create', 'create-before-restart'))
  assert.equal(refusedMutation.status, 2)
  assert.equal(JSON.parse(refusedMutation.stderr).error.code, 'OUTCOME_UNKNOWN')

  const replayedSend = await run(...callArgs(sendMethod, 'send-before-restart'))
  assert.equal(replayedSend.status, 2, replayedSend.stderr)
  assert.equal(JSON.parse(replayedSend.stdout).status, 'waiting')
  const deliveredReplay = await afterRestartPoll.promise
  assert.equal(deliveredReplay.response.status, 200)
  assert.equal(deliveredReplay.value.params.idempotencyKey, 'send-before-restart')

  await request(current.base, `/v1/instances/${fixture.instance.instanceId}/ack`, {
    method: 'POST', token: fixture.instance.instanceToken,
    body: { callId: deliveredReplay.value.callId, ok: true, result: { taskId: 'task-recovered' } },
  })
  const recoveredResult = await run(...callArgs(sendMethod, 'send-before-restart'))
  assert.equal(recoveredResult.status, 0, recoveredResult.stderr)
  assert.equal(JSON.parse(recoveredResult.stdout).result.taskId, 'task-recovered')
})
}

async function availablePort() {
  const server = createNetServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('client purpose validates 500 characters, participates in registration idempotency and survives restart', async t => {
  const {root,home}=await temporaryHome()
  let current=await start(home)
  t.after(async()=>{await current.bridge.close();await rm(root,{recursive:true,force:true})})
  const {instance}=await pairFixture(current.base,current.bridge.adminToken)
  const code=await request(current.base,`/v1/instances/${instance.instanceId}/pair-codes`,{method:'POST',token:instance.instanceToken,body:{purpose:'client'}})
  const body={code:code.value.code,name:'purpose client',registrationId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',purpose:'  分析资料  '}
  const register=body=>request(current.base,'/v1/clients/register',{method:'POST',body})
  assert.equal((await register({...body,purpose:'字'.repeat(501)})).response.status,400)
  assert.equal((await register({...body,purpose:123})).response.status,400)
  const first=await register(body)
  assert.equal(first.response.status,201)
  assert.equal(first.value.purpose,'分析资料')
  const retry=await register({...body,purpose:'分析资料'})
  assert.equal(retry.value.clientToken,first.value.clientToken)
  assert.equal((await register({...body,purpose:'其他用途'})).response.status,409)
  await current.bridge.close();current=await start(home)
  const restored=await register({...body,purpose:'分析资料'})
  assert.equal(restored.response.status,200)
  assert.equal(restored.value.purpose,'分析资料')
  const list=await request(current.base,`/v1/instances/${instance.instanceId}/clients`,{token:instance.instanceToken})
  assert.equal(list.value.clients.find(c=>c.clientId===first.value.clientId).purpose,'分析资料')
  const boundary=await request(current.base,`/v1/instances/${instance.instanceId}/pair-codes`,{method:'POST',token:instance.instanceToken,body:{purpose:'client'}})
  assert.equal((await register({...body,code:boundary.value.code,registrationId:'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',purpose:'🦉'.repeat(500)})).response.status,201)
})
