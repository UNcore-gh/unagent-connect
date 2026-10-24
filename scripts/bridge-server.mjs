import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rename, chmod, open, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROTOCOL_VERSION = 1
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 27123
export const MAX_BODY_BYTES = 1_048_576
export const MAX_RESULT_BYTES = MAX_BODY_BYTES - 4_096
export const PAIR_CODE_TTL_MS = 5 * 60_000
export const ONLINE_WINDOW_MS = 5_000
export const DELIVERY_LEASE_MS = 60_000
export const TRANSPORT_TTL_MS = 15 * 60_000
export const MAX_TRANSPORT_CALLS = 1_000
export const MAX_PENDING_CALLS = 64
const MAX_RETIRED_SESSIONS = 64
export const ALLOWED_METHODS = new Set([
  'participants.list', 'participants.send', 'sessions.read',
  'inbox.list', 'inbox.claim', 'inbox.complete', 'inbox.fail', 'inbox.question', 'inbox.heartbeat',
  'models.list',
  'agents.list',
  'sessions.list',
  'sessions.create',
  'sessions.update',
  'sessions.send',
  'connect.submit',
  'tasks.get',
  'tasks.wait',
  'tasks.answer',
  'tasks.cancel',
])

const ALLOWED_ORIGINS = new Set(['app://obsidian.md'])
const BUSINESS_IDEMPOTENCY_METHODS = new Set([
  'participants.send', 'inbox.claim', 'inbox.complete', 'inbox.fail',
  'sessions.send',
  'connect.submit',
])
const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

export function defaultBridgeHome() {
  if (process.env.NODE_ENV === 'test' && process.env.UNAGENT_BRIDGE_TEST_HOME) {
    return process.env.UNAGENT_BRIDGE_TEST_HOME
  }
  return path.join(os.homedir(), '.unagent', 'bridge')
}

export function createBridgeServer({
  home = defaultBridgeHome(),
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  now = Date.now,
} = {}) {
  const stateDir = path.resolve(home)
  const statePath = path.join(stateDir, 'bridge-state.json')
  const adminTokenPath = path.join(stateDir, 'host-admin.token')
  let state
  const bridgeId = randomId()
  let persistTail = Promise.resolve()
  let server
  let isClosed = false
  let cleanupTimer = null
  const pollWaiters = new Map()
  const connectionGenerations = new Map()
  const retiredSessions = new Map()
  const calls = new Map()
  const idempotency = new Map()
  const expiredCalls = new Map()

  async function ensureState() {
    const userConfigDir = path.dirname(stateDir)
    await mkdir(userConfigDir, { recursive: true, mode: 0o700 })
    await chmod(userConfigDir, 0o700)
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await chmod(stateDir, 0o700)
    let adminToken
    try {
      adminToken = (await readFile(adminTokenPath, 'utf8')).trim()
      if (!/^[a-f0-9]{64}$/.test(adminToken)) throw new Error('invalid host credential')
      await chmod(adminTokenPath, 0o600)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('本机桥接凭据文件无效或不可读取')
      adminToken = randomToken()
      const handle = await open(adminTokenPath, 'wx', 0o600)
      try {
        await handle.writeFile(`${adminToken}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    }

    try {
      state = JSON.parse(await readFile(statePath, 'utf8'))
      const hadUnsafeState = normalizeState(state)
      await chmod(statePath, 0o600)
      if (hadUnsafeState) await persist()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('本机桥接状态文件损坏，已停止启动以保护现有数据')
      state = emptyState()
      await persist()
    }
    return adminToken
  }

  function emptyState() {
    return {
      version: 1,
      instances: {},
      clients: {},
      pairCodes: {},
    }
  }

  function normalizeState(value) {
    if (!value || value.version !== 1) throw new Error('unsupported state')
    for (const key of ['instances', 'clients', 'pairCodes']) {
      if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
        throw new Error('invalid state')
      }
    }
    const normalized = { version: 1, instances: {}, clients: {}, pairCodes: {} }
    const legacyClientTokens = new Map()
    for (const [instanceId, item] of Object.entries(value.instances)) {
      if (
        !isRecord(item) ||
        item.instanceId !== instanceId ||
        !cleanName(item.name) ||
        !Number.isFinite(item.createdAt) ||
        !(item.lastSeenAt === null || Number.isFinite(item.lastSeenAt)) ||
        !isTokenHash(item.tokenHash)
      ) throw new Error('invalid instance state')
      normalized.instances[instanceId] = {
        instanceId,
        name: item.name,
        createdAt: item.createdAt,
        lastSeenAt: item.lastSeenAt,
        tokenHash: item.tokenHash,
      }
      attachRuntimeConnectionState(normalized.instances[instanceId])
    }
    for (const [clientId, item] of Object.entries(value.clients)) {
      if (
        !isRecord(item) ||
        item.clientId !== clientId ||
        !cleanName(item.name) ||
        (item.purpose !== undefined && (typeof item.purpose !== 'string' || Array.from(item.purpose).length > 500)) ||
        typeof item.instanceId !== 'string' ||
        !Number.isFinite(item.createdAt) ||
        !(item.revokedAt === null || Number.isFinite(item.revokedAt)) ||
        !isTokenHash(item.tokenHash)
      ) throw new Error('invalid client state')
      if (isTokenHash(item.clientToken)) legacyClientTokens.set(clientId, item.clientToken)
      normalized.clients[clientId] = {
        clientId,
        name: item.name,
        ...(item.purpose?.trim() ? {purpose:item.purpose.trim()} : {}),
        instanceId: item.instanceId,
        createdAt: item.createdAt,
        revokedAt: item.revokedAt,
        tokenHash: item.tokenHash,
      }
    }
    for (const [codeHash, item] of Object.entries(value.pairCodes)) {
      if (
        !isTokenHash(codeHash) ||
        !isRecord(item) ||
        !['host', 'client'].includes(item.purpose) ||
        !(item.instanceId === null || typeof item.instanceId === 'string') ||
        !Number.isFinite(item.createdAt) ||
        !Number.isFinite(item.expiresAt) ||
        !(item.usedAt === null || Number.isFinite(item.usedAt)) ||
        !(item.registeredClientId === undefined || item.registeredClientId === null || typeof item.registeredClientId === 'string')
      ) throw new Error('invalid pairing state')
      const record = {
        purpose: item.purpose,
        instanceId: item.instanceId,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        usedAt: item.usedAt,
        registeredClientId: item.registeredClientId ?? null,
      }
      for (const key of ['registrationId', 'clientName', 'registeredInstanceId', 'instanceName']) {
        if (typeof item[key] === 'string') record[key] = item[key]
      }
      for (const key of ['instanceToken', 'clientToken']) {
        if (isTokenHash(item[key])) record[key] = item[key]
      }
      if (!record.clientToken && typeof record.registeredClientId === 'string') {
        const legacyToken = legacyClientTokens.get(record.registeredClientId)
        if (legacyToken) record.clientToken = legacyToken
      }
      normalized.pairCodes[codeHash] = record
    }
    // Persist only the explicit identity/pairing schema. Older snapshots that
    // contained transport calls, results, clientToken copies, or unknown fields
    // are rewritten without them before the server begins accepting requests.
    const changed = JSON.stringify(value) !== JSON.stringify(normalized)
    state = normalized
    for (const instanceId of Object.keys(state.instances)) connectionGenerations.set(instanceId, 0)
    return changed
  }

  function persist(force = false) {
    if (isClosed && !force) return persistTail
    const snapshot = JSON.stringify(state)
    persistTail = persistTail.then(async () => {
      const temp = path.join(stateDir, `.bridge-state-${process.pid}-${randomToken()}.tmp`)
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(snapshot, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, statePath)
      await chmod(statePath, 0o600)
    })
    return persistTail
  }

  function json(res, status, payload, headers = {}) {
    if (res.writableEnded) return
    const body = JSON.stringify(payload)
    res.writeHead(status, { ...jsonHeaders, ...headers, 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  function noContent(res) {
    if (res.writableEnded) return
    res.writeHead(204, { 'Cache-Control': 'no-store' })
    res.end()
  }

  function fail(res, status, code, message) {
    json(res, status, { error: { code, message } })
  }

  function requestHostAllowed(req) {
    const actual = req.headers.host
    if (typeof actual !== 'string') return false
    const port = server?.address()?.port ?? DEFAULT_PORT
    return actual === `127.0.0.1:${port}` || actual === `localhost:${port}`
  }

  function originAllowed(req) {
    const origin = req.headers.origin
    return origin === undefined || (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin))
  }

  function applyCors(req, res) {
    if (req.headers.origin === 'app://obsidian.md') {
      res.setHeader('Access-Control-Allow-Origin', 'app://obsidian.md')
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-UNagent-Bridge-Session')
      res.setHeader('Access-Control-Max-Age', '300')
    }
  }

  async function readJson(req, res) {
    const type = String(req.headers['content-type'] || '').toLowerCase()
    if (!type.startsWith('application/json')) {
      fail(res, 415, 'BAD_REQUEST', '请求必须使用 application/json')
      return null
    }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(res, 413, 'PAYLOAD_TOO_LARGE', `请求体上限为 ${MAX_BODY_BYTES} 字节`)
        return null
      }
      chunks.push(chunk)
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
      return parsed
    } catch {
      fail(res, 400, 'BAD_REQUEST', '请求 JSON 格式不正确')
      return null
    }
  }

  function bearer(req) {
    const value = req.headers.authorization
    if (typeof value !== 'string' || !value.startsWith('Bearer ')) return ''
    return value.slice(7).trim()
  }

  function hostSessionId(req) {
    const sessionId = req.headers['x-unagent-bridge-session']
    return typeof sessionId === 'string' && /^[a-f0-9]{32}$/i.test(sessionId)
      ? sessionId.toLowerCase()
      : ''
  }

  function hashToken(token) {
    return createHash('sha256').update(token).digest('hex')
  }

  function findInstance(instanceId) {
    return state.instances[instanceId]
  }

  function authenticateAdmin(req) {
    const candidate = bearer(req)
    return candidate && safeEqual(hashToken(candidate), hashToken(server.adminToken))
  }

  function authenticateInstance(req, instanceId) {
    const instance = findInstance(instanceId)
    const candidate = bearer(req)
    return Boolean(instance && candidate && safeEqual(hashToken(candidate), instance.tokenHash))
  }

  function authenticateClient(req) {
    const candidate = bearer(req)
    if (!candidate) return null
    const tokenHash = hashToken(candidate)
    for (const client of Object.values(state.clients)) {
      if (!client.revokedAt && safeEqual(tokenHash, client.tokenHash)) return client
    }
    return null
  }

  function online(instance) {
    if (!instance.connected) return false
    return Boolean(instance.lastSeenAt && now() - instance.lastSeenAt <= ONLINE_WINDOW_MS)
  }

  function attachRuntimeConnectionState(instance) {
    Object.defineProperty(instance, 'connected', {
      value: false,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    Object.defineProperty(instance, 'activeSessionId', {
      value: '',
      writable: true,
      configurable: true,
      enumerable: false,
    })
    return instance
  }

  function cancelUnacknowledgedCalls(instanceId) {
    let cancelled = 0
    for (const call of calls.values()) {
      if (call.instanceId !== instanceId || !['queued', 'delivered'].includes(call.status)) continue
      call.status = 'cancelled'
      call.finishedAt = now()
      removeCallIdempotency(call)
      cancelled += 1
    }
    return cancelled
  }

  function removeCallIdempotency(call) {
    const key = `${call.clientId}:${call.instanceId}:${call.idempotencyKey}`
    if (idempotency.get(key) === call.callId) idempotency.delete(key)
  }

  function retireSession(instanceId, sessionId) {
    if (!sessionId) return
    let retired = retiredSessions.get(instanceId)
    if (!retired) {
      retired = new Set()
      retiredSessions.set(instanceId, retired)
    }
    retired.delete(sessionId)
    retired.add(sessionId)
    while (retired.size > MAX_RETIRED_SESSIONS) retired.delete(retired.values().next().value)
  }

  function isRetiredSession(instanceId, sessionId) {
    return retiredSessions.get(instanceId)?.has(sessionId) ?? false
  }

  function markDisconnected(instanceId, instance) {
    retireSession(instanceId, instance.activeSessionId)
    instance.connected = false
    instance.activeSessionId = ''
    connectionGenerations.set(instanceId, (connectionGenerations.get(instanceId) ?? 0) + 1)
    return cancelUnacknowledgedCalls(instanceId)
  }

  function publicError(error) {
    if (error instanceof BridgeHttpError) return error
    return new BridgeHttpError(500, 'INTERNAL_ERROR', '本机桥接处理失败')
  }

  function notifyPollers(instanceId) {
    const waiters = pollWaiters.get(instanceId)
    if (!waiters) return
    for (const wake of [...waiters]) wake()
  }

  function nextQueued(instanceId) {
    const instance = findInstance(instanceId)
    if (!instance) return null
    pruneTransportCache()
    const candidates = [...calls.values()]
      .filter((call) => call.instanceId === instanceId)
      .filter((call) => call.status === 'queued' || (call.status === 'delivered' && call.leaseUntil <= now()))
      .sort((a, b) => a.createdAt - b.createdAt)
    const call = candidates[0]
    if (!call) return null
    call.status = 'delivered'
    call.deliveredAt = now()
    call.leaseUntil = now() + DELIVERY_LEASE_MS
    instance.lastSeenAt = now()
    return call
  }

  function safeCall(call) {
    return {
      callId: call.callId,
      idempotencyKey: call.idempotencyKey,
      method: call.method,
      params: call.params,
      client: { clientId: call.clientId, clientName: call.clientName },
      deliveredAt: call.deliveredAt,
    }
  }

  async function longPoll(instanceId, sessionId, waitMs, res) {
    const instance = findInstance(instanceId)
    if (!instance) throw new BridgeHttpError(404, 'NOT_FOUND', '找不到这个插件实例')
    if (isRetiredSession(instanceId, sessionId)) {
      throw new BridgeHttpError(409, 'STALE_SESSION', '这条插件连接已关闭，请创建新的连接会话')
    }
    if (
      (instance.activeSessionId && instance.activeSessionId !== sessionId) ||
      (instance.connected && !online(instance))
    ) {
      markDisconnected(instanceId, instance)
      await persist()
      notifyPollers(instanceId)
    }
    if (isRetiredSession(instanceId, sessionId)) {
      throw new BridgeHttpError(409, 'STALE_SESSION', '这条插件连接已关闭，请创建新的连接会话')
    }
    instance.activeSessionId = sessionId
    const generation = (connectionGenerations.get(instanceId) ?? 0) + 1
    connectionGenerations.set(instanceId, generation)
    instance.connected = true
    instance.lastSeenAt = now()
    notifyPollers(instanceId)

    let settled = false
    let timer
    let wake
    const removeWaiter = () => {
      if (wake) pollWaiters.get(instanceId)?.delete(wake)
    }
    const finishEmpty = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeWaiter()
      noContent(res)
    }
    res.once('close', () => {
      if (!res.writableEnded && connectionGenerations.get(instanceId) === generation && instance.activeSessionId === sessionId) {
        markDisconnected(instanceId, instance)
        void persist().finally(() => notifyPollers(instanceId))
      }
      removeWaiter()
      if (!settled) {
        settled = true
        clearTimeout(timer)
      }
    })

    await persist()
    if (
      !instance.connected ||
      connectionGenerations.get(instanceId) !== generation ||
      instance.activeSessionId !== sessionId
    ) {
      finishEmpty()
      return
    }
    const immediate = nextQueued(instanceId)
    if (immediate) {
      await persist()
      if (
        !instance.connected ||
        connectionGenerations.get(instanceId) !== generation ||
        instance.activeSessionId !== sessionId ||
        immediate.status !== 'delivered'
      ) {
        finishEmpty()
        return
      }
      settled = true
      json(res, 200, safeCall(immediate))
      return
    }
    if (waitMs === 0 || isClosed) {
      finishEmpty()
      return
    }

    wake = async () => {
      if (settled || res.writableEnded) return
      if (
        isClosed ||
        !instance.connected ||
        connectionGenerations.get(instanceId) !== generation ||
        instance.activeSessionId !== sessionId
      ) {
        finishEmpty()
        return
      }
      const call = nextQueued(instanceId)
      if (!call) {
        instance.lastSeenAt = now()
        void persist().then(finishEmpty).catch(() => fail(res, 500, 'INTERNAL_ERROR', '本机桥接暂时无法读取请求'))
        return
      }
      settled = true
      clearTimeout(timer)
      removeWaiter()
      try {
        instance.lastSeenAt = now()
        await persist()
        if (
          !instance.connected ||
          connectionGenerations.get(instanceId) !== generation ||
          instance.activeSessionId !== sessionId ||
          call.status !== 'delivered'
        ) {
          noContent(res)
          return
        }
        json(res, 200, safeCall(call))
      } catch {
        fail(res, 500, 'INTERNAL_ERROR', '本机桥接暂时无法读取请求')
      }
    }
    if (!pollWaiters.has(instanceId)) pollWaiters.set(instanceId, new Set())
    pollWaiters.get(instanceId).add(wake)
    timer = setTimeout(() => void wake(), waitMs)
  }

  async function route(req, res) {
    applyCors(req, res)
    if (!requestHostAllowed(req)) return fail(res, 403, 'FORBIDDEN', 'Host 地址不受信任')
    if (!originAllowed(req)) return fail(res, 403, 'FORBIDDEN', '网页来源不受信任')
    pruneTransportCache()
    await pruneExpiredPairCodes()
    if (req.method === 'OPTIONS') {
      if (req.headers.origin !== 'app://obsidian.md') return fail(res, 403, 'FORBIDDEN', '网页来源不受信任')
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      return res.end()
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return json(res, 200, { service: 'unagent-connect', protocolVersion: PROTOCOL_VERSION, bridgeId })
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/status') {
      if (!authenticateAdmin(req)) return fail(res, 401, 'UNAUTHORIZED', '桥接管理凭据无效')
      return json(res, 200, {
        service: 'unagent-connect',
        protocolVersion: PROTOCOL_VERSION,
        bridgeId,
        address: `http://127.0.0.1:${server.address().port}`,
        instances: Object.keys(state.instances).length,
      })
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/instances') {
      if (!authenticateAdmin(req)) return fail(res, 401, 'UNAUTHORIZED', '桥接管理凭据无效')
      return json(res, 200, {
        instances: Object.values(state.instances).map((item) => ({
          instanceId: item.instanceId,
          name: item.name,
          createdAt: item.createdAt,
          lastSeenAt: item.lastSeenAt ?? null,
          online: online(item),
        })),
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/admin/pair-codes') {
      if (!authenticateAdmin(req)) return fail(res, 401, 'UNAUTHORIZED', '桥接管理凭据无效')
      const body = await readJson(req, res)
      if (!body) return
      if (body.purpose !== 'host') return fail(res, 400, 'BAD_REQUEST', '管理端只可签发插件主机配对码')
      return issuePairCode({ purpose: 'host', res })
    }

    if (req.method === 'POST' && url.pathname === '/v1/hosts/pair') {
      const body = await readJson(req, res)
      if (!body) return
      const name = cleanName(body.name)
      const registrationId = cleanId(body.registrationId)
      if (!name || !registrationId) return fail(res, 400, 'BAD_REQUEST', '实例名称或注册编号不正确')
      const found = findPairCode(body.code, 'host')
      if (!found) return fail(res, 401, 'UNAUTHORIZED', '配对码无效或已过期')
      const codeRecord = found.record
      if (codeRecord.registeredInstanceId) {
        if (codeRecord.registrationId !== registrationId || codeRecord.instanceName !== name) {
          return fail(res, 409, 'FORBIDDEN', '该配对码已绑定其他插件实例')
        }
        const paired = state.instances[codeRecord.registeredInstanceId]
        if (!paired) return fail(res, 410, 'REQUEST_EXPIRED', '这个实例已解除配对，请重新生成配对码')
        return json(res, 200, {
          instanceId: paired.instanceId,
          instanceToken: codeRecord.instanceToken,
          name: paired.name,
          protocolVersion: PROTOCOL_VERSION,
        })
      }
      if (codeRecord.usedAt) return fail(res, 401, 'UNAUTHORIZED', '配对码已使用')
      const instanceId = randomId()
      const instanceToken = randomToken()
      const item = {
        instanceId,
        name,
        createdAt: now(),
        lastSeenAt: null,
        tokenHash: hashToken(instanceToken),
      }
      attachRuntimeConnectionState(item)
      state.instances[instanceId] = item
      connectionGenerations.set(instanceId, 0)
      codeRecord.usedAt = now()
      codeRecord.registrationId = registrationId
      codeRecord.instanceName = name
      codeRecord.registeredInstanceId = instanceId
      codeRecord.instanceToken = instanceToken
      await persist()
      return json(res, 201, { instanceId, instanceToken, name, protocolVersion: PROTOCOL_VERSION })
    }

    if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'instances' && parts[3] === 'pair-codes') {
      const instanceId = parts[2]
      if (!authenticateInstance(req, instanceId)) return fail(res, 401, 'UNAUTHORIZED', '插件主机凭据无效')
      const body = await readJson(req, res)
      if (!body) return
      if (body.purpose !== 'client') return fail(res, 400, 'BAD_REQUEST', '插件主机只可签发外部客户端配对码')
      return issuePairCode({ purpose: 'client', instanceId, res })
    }

    if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'instances' && parts[3] === 'status') {
      const instanceId = parts[2]
      if (!authenticateInstance(req, instanceId)) return fail(res, 401, 'UNAUTHORIZED', '插件主机凭据无效')
      const instance = findInstance(instanceId)
      return json(res, 200, {
        protocolVersion: PROTOCOL_VERSION,
        instanceId,
        name: instance.name,
        online: online(instance),
        lastSeenAt: instance.lastSeenAt ?? null,
      })
    }

    if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'instances' && parts[3] === 'disconnect') {
      const instanceId = parts[2]
      const instance = findInstance(instanceId)
      if (!authenticateInstance(req, instanceId)) return fail(res, 401, 'UNAUTHORIZED', '插件主机凭据无效')
      const sessionId = hostSessionId(req)
      if (!sessionId || (instance.activeSessionId && instance.activeSessionId !== sessionId)) {
        return fail(res, 409, 'STALE_SESSION', '连接已被新的插件会话取代')
      }
      const cancelledCalls = markDisconnected(instanceId, instance)
      retireSession(instanceId, sessionId)
      await persist()
      notifyPollers(instanceId)
      return json(res, 200, { disconnected: true, instanceId, cancelledCalls })
    }

    if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'instances' && parts[3] === 'heartbeat') {
      const instanceId = parts[2]
      const instance = findInstance(instanceId)
      if (!authenticateInstance(req, instanceId)) return fail(res, 401, 'UNAUTHORIZED', '插件主机凭据无效')
      const sessionId = hostSessionId(req)
      if (!sessionId || instance.activeSessionId !== sessionId || !instance.connected) {
        return fail(res, 409, 'STALE_SESSION', '插件连接已断开，请重新建立长轮询')
      }
      instance.lastSeenAt = now()
      return json(res, 200, { heartbeat: true, instanceId })
    }

    if (req.method === 'POST' && url.pathname === '/v1/clients/register') {
      const body = await readJson(req, res)
      if (!body) return
      if (body.purpose !== undefined && (typeof body.purpose !== 'string' || Array.from(body.purpose).length > 500)) return fail(res, 400, 'BAD_REQUEST', '客户端用途最多500字')
      const purpose = body.purpose?.trim() || undefined
      const name = cleanName(body.name)
      const registrationId = cleanId(body.registrationId)
      if (!name || !registrationId) return fail(res, 400, 'BAD_REQUEST', '客户端名称或注册编号不正确')
      const lookup = findPairCode(body.code, 'client')
      if (!lookup) return fail(res, 401, 'UNAUTHORIZED', '客户端配对码无效、已过期或已使用')
      const codeRecord = lookup.record
      if (codeRecord.registeredClientId) {
        const registered = state.clients[codeRecord.registeredClientId]
        if (codeRecord.registrationId !== registrationId || codeRecord.clientName !== name || !registered || (registered.purpose || undefined) !== purpose) {
          return fail(res, 409, 'FORBIDDEN', '该配对码已绑定其他客户端')
        }
        if (registered.revokedAt) return fail(res, 410, 'REQUEST_EXPIRED', '这个客户端已撤销，请重新生成配对码')
        return json(res, 200, {
          clientId: registered.clientId,
          clientToken: codeRecord.clientToken,
          clientName: registered.name,
          ...(registered.purpose ? {purpose:registered.purpose} : {}),
          instanceId: registered.instanceId,
        })
      }
      const token = randomToken()
      const clientId = randomId()
      const client = {
        clientId,
        name,
        ...(purpose ? {purpose} : {}),
        instanceId: codeRecord.instanceId,
        createdAt: now(),
        revokedAt: null,
        tokenHash: hashToken(token),
      }
      state.clients[clientId] = client
      codeRecord.registeredClientId = clientId
      codeRecord.registrationId = registrationId
      codeRecord.clientName = name
      codeRecord.clientToken = token
      await persist()
      return json(res, 201, {
        clientId,
        clientToken: token,
        clientName: name,
        ...(purpose ? {purpose} : {}),
        instanceId: client.instanceId,
      })
    }

    if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'instances' && parts[3] === 'clients') {
      const instanceId = parts[2]
      if (!authenticateInstance(req, instanceId)) return fail(res, 401, 'UNAUTHORIZED', '插件主机凭据无效')
      return json(res, 200, {
        clients: Object.values(state.clients)
          .filter((client) => client.instanceId === instanceId)
          .map(({ clientId, name, purpose, createdAt, revokedAt }) => ({ clientId, name, ...(purpose ? {purpose} : {}), createdAt, revokedAt })),
      })
    }

    if (req.method === 'DELETE' && parts.length === 5 && parts[0] === 'v1' && parts[1] === 'instances' && parts[3] === 'clients') {
      const [, , instanceId, , clientId] = parts
      if (!authenticateInstance(req, instanceId)) return fail(res, 401, 'UNAUTHORIZED', '插件主机凭据无效')
      const client = state.clients[clientId]
      if (!client || client.instanceId !== instanceId) return fail(res, 404, 'NOT_FOUND', '找不到这个客户端')
      client.revokedAt = now()
      for (const call of calls.values()) {
        if (call.clientId === clientId && call.status === 'queued') { call.status = 'cancelled'; call.completedAt = now() }
      }
      await persist()
      return json(res, 200, { revoked: true, clientId })
    }

    if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'instances' && parts[3] === 'next') {
      const instanceId = parts[2]
      if (!authenticateInstance(req, instanceId)) return fail(res, 401, 'UNAUTHORIZED', '插件主机凭据无效')
      const sessionId = hostSessionId(req)
      if (!sessionId) return fail(res, 400, 'BAD_REQUEST', '缺少插件连接会话编号')
      const waitMs = Number(url.searchParams.get('waitMs') ?? '25000')
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) return fail(res, 400, 'BAD_REQUEST', '长轮询等待时间必须在 0 到 25000 毫秒之间')
      return longPoll(instanceId, sessionId, waitMs, res)
    }

    if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'instances' && parts[3] === 'ack') {
      const instanceId = parts[2]
      if (!authenticateInstance(req, instanceId)) return fail(res, 401, 'UNAUTHORIZED', '插件主机凭据无效')
      const body = await readJson(req, res)
      if (!body) return
      const call = calls.get(body.callId)
      if (!call || call.instanceId !== instanceId) return fail(res, 404, 'NOT_FOUND', '找不到这个桥接请求')
      if (call.status === 'completed' || call.status === 'failed') return json(res, 200, { acknowledged: true, duplicate: true })
      if (call.status !== 'delivered') return fail(res, 409, 'BAD_REQUEST', '请求尚未投递或已取消')
      if (body.ok === true) {
        const result = body.result === undefined ? null : body.result
        const resultText = JSON.stringify(result)
        if (typeof resultText !== 'string') return fail(res, 400, 'BAD_REQUEST', '业务结果必须是 JSON 数据')
        if (Buffer.byteLength(resultText) > MAX_RESULT_BYTES) return fail(res, 413, 'PAYLOAD_TOO_LARGE', `业务结果上限为 ${MAX_RESULT_BYTES} 字节`)
        call.acknowledgedAt = now()
        call.leaseUntil = 0
        call.status = 'completed'
        call.result = result
      } else {
        call.acknowledgedAt = now()
        call.leaseUntil = 0
        call.status = 'failed'
        call.error = cleanError(body.error)
        removeCallIdempotency(call)
      }
      return json(res, 200, { acknowledged: true, status: call.status })
    }

    if (req.method === 'DELETE' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'instances') {
      const instanceId = parts[2]
      if (!authenticateInstance(req, instanceId)) return fail(res, 401, 'UNAUTHORIZED', '插件主机凭据无效')
      const instance = findInstance(instanceId)
      const cancelledCalls = markDisconnected(instanceId, instance)
      delete state.instances[instanceId]
      connectionGenerations.delete(instanceId)
      retiredSessions.delete(instanceId)
      for (const client of Object.values(state.clients)) {
        if (client.instanceId === instanceId && !client.revokedAt) client.revokedAt = now()
      }
      notifyPollers(instanceId)
      return json(res, 200, { unpaired: true, instanceId, cancelledCalls })
    }

    if (req.method === 'POST' && url.pathname === '/v1/calls') {
      const client = authenticateClient(req)
      if (!client) return fail(res, 401, 'UNAUTHORIZED', '客户端凭据无效或已撤销')
      const body = await readJson(req, res)
      if (!body) return
      const { instanceId, method, params, idempotencyKey } = body
      if (instanceId !== client.instanceId) return fail(res, 403, 'FORBIDDEN', '这个客户端没有调用该插件实例的权限')
      if (!ALLOWED_METHODS.has(method)) return fail(res, 404, 'METHOD_NOT_FOUND', '不支持这个业务方法')
      if (!validIdempotencyKey(idempotencyKey)) return fail(res, 400, 'BAD_REQUEST', '必须提供 1 到 128 个字符的幂等编号')
      if (
        BUSINESS_IDEMPOTENCY_METHODS.has(method) &&
        (!params || typeof params !== 'object' || params.idempotencyKey !== idempotencyKey)
      ) {
        return fail(res, 400, 'BAD_REQUEST', '这个业务方法要求 params.idempotencyKey 与桥接幂等编号一致')
      }
      const instance = findInstance(instanceId)
      if (!instance) return fail(res, 503, 'INSTANCE_OFFLINE', '这个 Obsidian 插件实例当前离线')
      let paramsText
      try {
        paramsText = stableStringify(params ?? {})
      } catch {
        return fail(res, 400, 'BAD_REQUEST', '业务参数必须是 JSON 数据')
      }
      const requestHash = hashToken(`${instanceId}\n${method}\n${paramsText}`)
      const idemIndex = `${client.clientId}:${instanceId}:${idempotencyKey}`
      const existingId = idempotency.get(idemIndex)
      if (existingId) {
        const existing = calls.get(existingId)
        if (!existing || existing.requestHash !== requestHash) return fail(res, 409, 'IDEMPOTENCY_CONFLICT', '这个幂等编号已用于不同的业务请求')
        return json(res, 200, callSummary(existing))
      }
      if (!online(instance)) {
        if (instance.connected) {
          markDisconnected(instanceId, instance)
          await persist()
          notifyPollers(instanceId)
        }
        return fail(res, 503, 'INSTANCE_OFFLINE', '这个 Obsidian 插件实例当前离线')
      }
      const pending = [...calls.values()].filter((item) => ['queued', 'delivered'].includes(item.status)).length
      if (pending >= MAX_PENDING_CALLS) return fail(res, 503, 'QUEUE_FULL', '本机桥接待处理队列已满，请稍后重试')
      const callId = randomId()
      const call = {
        callId,
        clientId: client.clientId,
        clientName: client.name,
        instanceId,
        method,
        params: JSON.parse(paramsText),
        idempotencyKey,
        requestHash,
        createdAt: now(),
        expiresAt: now() + TRANSPORT_TTL_MS,
        status: 'queued',
      }
      calls.set(callId, call)
      idempotency.set(idemIndex, callId)
      pruneTransportCache()
      notifyPollers(instanceId)
      return json(res, 202, callSummary(call))
    }

    if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'calls') {
      const client = authenticateClient(req)
      if (!client) return fail(res, 401, 'UNAUTHORIZED', '客户端凭据无效或已撤销')
      const call = calls.get(parts[2])
      if (!call && expiredCalls.has(parts[2])) {
        const expired = expiredCalls.get(parts[2])
        if (expired.clientId === client.clientId) {
          return json(res, 200, { callId: parts[2], status: 'expired' })
        }
        return fail(res, 404, 'NOT_FOUND', '找不到这个业务请求')
      }
      if (!call || call.clientId !== client.clientId) return fail(res, 404, 'NOT_FOUND', '找不到这个业务请求')
      return json(res, 200, callSummary(call))
    }

    if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'calls' && parts[3] === 'cancel') {
      const client = authenticateClient(req)
      if (!client) return fail(res, 401, 'UNAUTHORIZED', '客户端凭据无效或已撤销')
      const call = calls.get(parts[2])
      if (!call || call.clientId !== client.clientId) return fail(res, 404, 'NOT_FOUND', '找不到这个业务请求')
      if (call.status !== 'queued') return fail(res, 409, 'BAD_REQUEST', '已投递的业务调用不能从桥接队列撤回，请使用 tasks.cancel')
      call.status = 'cancelled'
      call.finishedAt = now()
      removeCallIdempotency(call)
      return json(res, 200, callSummary(call))
    }

    return fail(res, 404, 'NOT_FOUND', '找不到这个桥接接口')
  }

  function callSummary(call) {
    return {
      callId: call.callId,
      instanceId: call.instanceId,
      method: call.method,
      status: call.status,
      createdAt: call.createdAt,
      deliveredAt: call.deliveredAt ?? null,
      finishedAt: call.finishedAt ?? call.acknowledgedAt ?? null,
      expiresAt: call.expiresAt,
      businessAcked: call.status === 'completed' || call.status === 'failed',
      result: call.status === 'completed' ? call.result : undefined,
      error: call.error,
    }
  }

  function pruneTransportCache() {
    const current = now()
    for (const [callId, call] of calls) {
      if (call.expiresAt > current) continue
      calls.delete(callId)
      idempotency.delete(`${call.clientId}:${call.instanceId}:${call.idempotencyKey}`)
      expiredCalls.set(callId, { clientId: call.clientId, expiresAt: current + TRANSPORT_TTL_MS })
    }
    for (const [callId, record] of expiredCalls) {
      if (record.expiresAt <= current) expiredCalls.delete(callId)
    }
    while (calls.size > MAX_TRANSPORT_CALLS) {
      const oldest = calls.values().next().value
      if (!oldest) break
      calls.delete(oldest.callId)
      idempotency.delete(`${oldest.clientId}:${oldest.instanceId}:${oldest.idempotencyKey}`)
      expiredCalls.set(oldest.callId, { clientId: oldest.clientId, expiresAt: current + TRANSPORT_TTL_MS })
    }
    while (expiredCalls.size > MAX_TRANSPORT_CALLS) {
      expiredCalls.delete(expiredCalls.keys().next().value)
    }
  }

  async function pruneExpiredPairCodes() {
    const before = Object.keys(state.pairCodes).length
    for (const [codeHash, record] of Object.entries(state.pairCodes)) {
      if (record.expiresAt <= now()) delete state.pairCodes[codeHash]
    }
    if (Object.keys(state.pairCodes).length !== before) await persist()
  }

  function issuePairCode({ purpose, instanceId, res }) {
    const code = randomBytes(16).toString('hex')
    const codeHash = hashToken(code)
    state.pairCodes[codeHash] = {
      purpose,
      instanceId: instanceId ?? null,
      createdAt: now(),
      expiresAt: now() + PAIR_CODE_TTL_MS,
      usedAt: null,
      registeredClientId: null,
    }
    return persist().then(() => json(res, 201, { code, purpose, expiresAt: state.pairCodes[codeHash].expiresAt }))
  }

  function findPairCode(rawCode, purpose) {
    const normalized = String(rawCode || '').replace(/[\s-]/g, '').toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(normalized)) return null
    const codeHash = hashToken(normalized)
    const record = state.pairCodes[codeHash]
    if (!record || record.purpose !== purpose || record.expiresAt <= now()) return null
    if (record.usedAt && !record.registeredClientId && !record.registeredInstanceId) return null
    return { codeHash, record }
  }

  async function createHandler() {
    const adminToken = await ensureState()
    server = createServer((req, res) => {
      void route(req, res).catch((error) => {
        const exposed = publicError(error)
        fail(res, exposed.status, exposed.code, exposed.message)
      })
    })
    server.adminToken = adminToken
    return server
  }

  async function listen() {
    if (!server) await createHandler()
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve()
      })
    })
    server.timeout = 35_000
    server.headersTimeout = 10_000
    server.requestTimeout = 15_000
    cleanupTimer = setInterval(() => {
      pruneTransportCache()
      void pruneExpiredPairCodes().catch(() => undefined)
    }, 60_000)
    cleanupTimer.unref?.()
    return server.address()
  }

  async function close() {
    isClosed = true
    if (cleanupTimer) clearInterval(cleanupTimer)
    cleanupTimer = null
    for (const waiters of pollWaiters.values()) for (const wake of [...waiters]) wake()
    if (server?.listening) {
      const closed = new Promise((resolve) => server.close(resolve))
      server.closeAllConnections?.()
      await closed
    }
    await persist(true)
  }

  return {
    get adminToken() {
      return server?.adminToken
    },
    get address() {
      return server?.address() ?? null
    },
    get stateDirectory() {
      return stateDir
    },
    listen,
    close,
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isTokenHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export class BridgeHttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function randomToken() {
  return randomBytes(32).toString('hex')
}

function randomId() {
  return randomBytes(16).toString('hex')
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
  let mismatch = 0
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return mismatch === 0
}

function cleanName(value) {
  if (typeof value !== 'string') return ''
  const name = value.trim()
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return ''
  return name
}

function cleanId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{8,80}$/i.test(value) ? value : ''
}

function validIdempotencyKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\w.:/-]+$/.test(value)
}

function cleanError(value) {
  if (!value || typeof value !== 'object') return { code: 'INTERNAL_ERROR', message: '插件业务处理失败' }
  const code = typeof value.code === 'string' ? value.code.slice(0, 80) : 'INTERNAL_ERROR'
  const message = typeof value.message === 'string' ? value.message.slice(0, 2000) : '插件业务处理失败'
  return { code, message }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? 'null').join(',')}]`
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
  return `{${entries.join(',')}}`
}

export async function runServerProcess() {
  const argument = process.argv.find((value) => value.startsWith('--port='))?.slice(7)
  const configuredPort = Number(argument || process.env.UNAGENT_BRIDGE_PORT || DEFAULT_PORT)
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
    process.stderr.write('BAD_PORT: 端口必须在 1 到 65535 之间\n')
    process.exitCode = 1
    return
  }
  const bridge = createBridgeServer({ port: configuredPort })
  const pidPath = path.join(bridge.stateDirectory, 'bridge.pid')
  try {
    const address = await bridge.listen()
    await writeFile(pidPath, `${process.pid}\n`, { mode: 0o600 })
    await chmod(pidPath, 0o600)
    process.stdout.write(`UNagent bridge listening on 127.0.0.1:${address.port}\n`)
    let stopping = false
    const shutdown = () => {
      if (stopping) return
      stopping = true
      void bridge.close().finally(async () => {
        await unlink(pidPath).catch(() => undefined)
        process.exit(0)
      })
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch (error) {
    const code = error?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'START_FAILED'
    process.stderr.write(`${code}: ${error?.code === 'EADDRINUSE' ? `127.0.0.1:${configuredPort} 已被占用` : '本机桥接启动失败'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runServerProcess()
}
