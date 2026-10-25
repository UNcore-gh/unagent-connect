#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { runHeartbeat, heartbeatCall } from './heartbeat.mjs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, open, chmod, stat, unlink } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { connect as connectTcp } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(SCRIPT_DIR, 'bridge-server.mjs')
let ADDRESS = 'http://127.0.0.1:27123'
const HOME = process.env.NODE_ENV === 'test' && process.env.UNAGENT_BRIDGE_TEST_HOME
  ? process.env.UNAGENT_BRIDGE_TEST_HOME
  : path.join(os.homedir(), '.unagent', 'bridge')
const TOKEN_PATH = path.join(HOME, 'host-admin.token')
const PID_PATH = path.join(HOME, 'bridge.pid')
const LOCK_PATH = path.join(HOME, 'start.lock')
const CONFIG_PATH = path.join(HOME, 'bridge-config.json')
const MAX_BODY_BYTES = 1_048_576

class CliError extends Error {
  constructor(message, code = 'CLI_ERROR', exitCode = 1) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function printError(error) {
  const code = error instanceof CliError ? error.code : 'CLI_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`)
  process.exitCode = error instanceof CliError ? error.exitCode : 1
}

async function ensurePrivateDirs() {
  const userDir = path.dirname(HOME)
  await mkdir(userDir, { recursive: true, mode: 0o700 })
  await chmod(userDir, 0o700)
  await mkdir(HOME, { recursive: true, mode: 0o700 })
  await chmod(HOME, 0o700)
}

async function configureAddress(command, options) {
  await ensurePrivateDirs()
  let savedAddress = ADDRESS
  let hasSavedAddress = false
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    savedAddress = normalizeAddress(config.address)
    hasSavedAddress = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new CliError('桥接地址配置损坏。', 'CONFIG_INVALID')
  }
  const specified = options.address !== undefined || options.port !== undefined
  const requested = options.address !== undefined
    ? normalizeAddress(options.address)
    : options.port !== undefined
      ? normalizeAddress(`http://127.0.0.1:${options.port}`)
      : savedAddress

  if (specified && command !== 'start' && requested !== savedAddress) {
    throw new CliError(`当前桥接地址是 ${savedAddress}；只可通过 start --port/--address 显式更改。`, 'PORT_CONFIG_MISMATCH')
  }
  if (command === 'start' && requested !== savedAddress) {
    const hasAdminCredential = Boolean(await readAdminToken(false))
    if (hasSavedAddress || hasAdminCredential) {
      ADDRESS = savedAddress
      let oldService = null
      try {
        oldService = await existingService()
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== 'PORT_CONFLICT') throw error
      }
      if (oldService) throw new CliError(`桥接仍在 ${savedAddress} 运行；先运行 stop，再指定新端口。`, 'PORT_CHANGE_REQUIRES_STOP')
    }
    ADDRESS = requested
    await writePrivateJson(CONFIG_PATH, { address: requested })
  } else {
    ADDRESS = requested
    if (command === 'start') await writePrivateJson(CONFIG_PATH, { address: requested })
  }
}

function normalizeAddress(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new CliError('桥接地址格式不正确。', 'ADDRESS_INVALID')
  }
  const explicitPort = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/i.exec(String(raw).trim())?.[1]
  const port = Number(url.port || explicitPort || 27123)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new CliError('桥接地址只能是本机回环地址 http://127.0.0.1:<端口>。', 'ADDRESS_INVALID')
  }
  return `http://127.0.0.1:${port}`
}

async function readAdminToken(required = true) {
  try {
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid')
    await chmod(TOKEN_PATH, 0o600)
    return token
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return null
    if (error?.code === 'ENOENT') throw new CliError('桥接尚未初始化；先运行 start。', 'NOT_STARTED')
    throw new CliError('本机桥接管理凭据不可读取或格式错误。', 'CREDENTIAL_INVALID')
  }
}

async function fetchJson(route, { token, method = 'GET', body, allowStatuses = [] } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetch(new URL(route, ADDRESS), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    })
  } catch (error) {
    throw new CliError(`无法连接本机桥接：${error instanceof Error ? error.message : String(error)}`, 'BRIDGE_UNREACHABLE')
  }
  if (response.status === 204) return { status: response.status, value: null }
  let payload
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok && !allowStatuses.includes(response.status)) {
    const code = payload?.error?.code || `HTTP_${response.status}`
    const message = payload?.error?.message || `本机桥接返回 HTTP ${response.status}`
    throw new CliError(message, code)
  }
  return { status: response.status, value: payload }
}

async function getAdminStatus(token) {
  return fetchJson('/v1/admin/status', { token })
}

async function existingService() {
  const token = await readAdminToken(false)
  if (!token) return null
  try {
    const status = await getAdminStatus(token)
    return { token, status: status.value }
  } catch (error) {
    if (error instanceof CliError && error.code === 'UNAUTHORIZED') {
      throw new CliError(`${new URL(ADDRESS).port || '27123'} 端口已被占用，但运行中的服务不是本机桥接；没有自动换端口。`, 'PORT_CONFLICT')
    }
    if (error instanceof CliError && error.code === 'BRIDGE_UNREACHABLE') return null
    throw error
  }
}

async function acquireStartupLock() {
  await ensurePrivateDirs()
  for (let attempt = 0; attempt < 70; attempt += 1) {
    try {
      const handle = await open(LOCK_PATH, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n`, 'utf8')
      await handle.close()
      return async () => unlink(LOCK_PATH).catch(() => undefined)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const lockStat = await stat(LOCK_PATH)
        if (Date.now() - lockStat.mtimeMs > 60_000) {
          await unlink(LOCK_PATH).catch(() => undefined)
          continue
        }
      } catch {
        continue
      }
      await delay(250)
      const running = await existingService().catch((statusError) => {
        if (statusError instanceof CliError && statusError.code === 'PORT_CONFLICT') throw statusError
        return null
      })
      if (running) return null
    }
  }
  throw new CliError('另一个启动操作仍在进行；稍后重试。', 'START_LOCKED')
}

async function ensureStarted() {
  const prior = await existingService()
  if (prior) return prior
  const release = await acquireStartupLock()
  if (!release) {
    const running = await existingService()
    if (running) return running
    throw new CliError('桥接启动锁冲突，请稍后重试。', 'START_LOCKED')
  }
  try {
    const again = await existingService()
    if (again) return again
    spawn(process.execPath, [SERVER_PATH], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, UNAGENT_BRIDGE_PORT: String(new URL(ADDRESS).port || 27123) },
    }).unref()

    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const running = await existingService().catch((error) => {
        if (error instanceof CliError && error.code === 'PORT_CONFLICT') throw error
        return null
      })
      if (running) return running
      await delay(200)
    }
    let health = null
    try {
      health = await fetchJson('/v1/health')
    } catch {
      // The diagnostic below is intentionally generic and never includes a token.
    }
    const port = new URL(ADDRESS).port || '27123'
    if (health || await isTcpPortOpen(port)) throw new CliError(`${port} 端口已被占用，但无法用当前凭据验证该服务；没有自动换端口。`, 'PORT_CONFLICT')
    throw new CliError(`本机桥接没有在 8 秒内启动；检查 Node.js 和端口 ${port}。`, 'START_FAILED')
  } finally {
    await release()
  }
}

function isTcpPortOpen(portText) {
  return new Promise((resolve) => {
    const socket = connectTcp({ host: '127.0.0.1', port: Number(portText) })
    const finish = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(400, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function commandStart() {
  const prior = await existingService()
  await ensureStarted()
  printJson({ running: true, address: ADDRESS, protocolVersion: 1, alreadyRunning: Boolean(prior) })
}

async function commandStatus() {
  const token = await readAdminToken(false)
  if (!token) return printJson({ running: false, address: ADDRESS, protocolVersion: 1 })
  try {
    const result = await getAdminStatus(token)
    printJson({ running: true, address: ADDRESS, protocolVersion: 1, ...result.value })
  } catch (error) {
    if (error instanceof CliError && error.code === 'BRIDGE_UNREACHABLE') {
      return printJson({ running: false, address: ADDRESS, protocolVersion: 1 })
    }
    throw error
  }
}

async function commandStop() {
  const token = await readAdminToken(false)
  if (!token) return printJson({ stopped: false, running: false })
  const { value: status } = await getAdminStatus(token)
  let pid
  try {
    pid = Number((await readFile(PID_PATH, 'utf8')).trim())
  } catch {
    throw new CliError('桥接正在运行，但缺少进程标记文件；为避免误停其他程序，未发送停止信号。', 'PID_MISSING')
  }
  if (!Number.isInteger(pid) || pid <= 1) throw new CliError('桥接进程标记无效；未发送停止信号。', 'PID_INVALID')
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await getAdminStatus(token)
    } catch (error) {
      if (error instanceof CliError && error.code === 'BRIDGE_UNREACHABLE') {
        return printJson({ stopped: true, running: false, address: ADDRESS })
      }
    }
    await delay(100)
  }
  throw new CliError(`桥接进程 ${pid} 未在 5 秒内退出（${status.address}）。`, 'STOP_TIMEOUT')
}

async function commandPairCode() {
  const { token } = await ensureStarted()
  const { value } = await fetchJson('/v1/admin/pair-codes', {
    method: 'POST',
    token,
    body: { purpose: 'host' },
  })
  printJson({ code: value.code, purpose: value.purpose, expiresAt: value.expiresAt, address: ADDRESS })
}

async function commandListInstances() {
  const { token } = await ensureStarted()
  const { value } = await fetchJson('/v1/admin/instances', { token })
  printJson(value)
}

async function commandClientRegister(options) {
  await ensureStarted()
  const name = requiredOption(options, 'name')
  const purpose = options.purpose === undefined ? undefined : requiredOption(options, 'purpose')
  const profile = options.profile || name
  const profilePath = clientProfilePath(profile)
  await mkdir(path.dirname(profilePath), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(profilePath), 0o700)

  let profileData = null
  try {
    profileData = JSON.parse(await readFile(profilePath, 'utf8'))
    if (profileData.name !== name) throw new CliError('这个本地配置名已对应另一个客户端名称。', 'PROFILE_NAME_CONFLICT')
    if (profileData.clientToken && profileData.instanceId && !options.replace) {
      if (purpose !== undefined && purpose !== profileData.purpose) throw new CliError('用途与已配对客户端不同；如需更改，请先在宿主撤销并重新配对，不会静默覆盖用途。', 'PROFILE_PURPOSE_CONFLICT')
      return printJson({ registered: true, reused: true, clientId: profileData.clientId, clientName: profileData.name, purpose: profileData.purpose, instanceId: profileData.instanceId, profile })
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error?.code !== 'ENOENT') throw new CliError('客户端本地配置损坏。', 'PROFILE_INVALID')
  }

  const code = await readPairCode(options)
  const registrationId = profileData?.registrationId || randomUUID()
  profileData = { name, purpose, registrationId }
  await writePrivateJson(profilePath, profileData)
  const { value } = await fetchJson('/v1/clients/register', {
    method: 'POST',
    body: { code, name, registrationId, ...(purpose === undefined ? {} : { purpose }) },
  })
  await writePrivateJson(profilePath, {
    name: value.clientName,
    purpose: value.purpose ?? purpose,
    registrationId,
    clientId: value.clientId,
    clientToken: value.clientToken,
    instanceId: value.instanceId,
  })
  printJson({ registered: true, clientId: value.clientId, clientName: value.clientName, instanceId: value.instanceId, profile })
}

async function commandCall(method, options) {
  await ensureStarted()
  const { value: health } = await fetchJson('/v1/health')
  const bridgeId = health.bridgeId
  if (typeof bridgeId !== 'string' || !bridgeId) throw new CliError('本机桥接没有提供进程编号，无法安全判断重启前的调用状态。', 'BRIDGE_VERSION')
  const instanceId = requiredOption(options, 'instance')
  const clientName = requiredOption(options, 'client')
  const profile = await readClientProfile(clientName)
  if (profile.instanceId !== instanceId) throw new CliError('所选客户端不属于这个实例，请检查 --instance。', 'INSTANCE_MISMATCH')
  if (options.requestId) {
    const value = await pollCall(options.requestId, profile.clientToken, options.timeoutMs)
    printJson(value)
    if (value.status !== 'completed') process.exitCode = 2
    return
  }
  const idem = requiredOption(options, 'idem')
  const params = withBusinessIdempotencyKey(method, await readParams(options), idem)

  const localRecordPath = callRecordPath(profile.clientId, instanceId, idem)
  const requestFingerprint = hash(`${instanceId}\n${method}\n${stableStringify(params)}`)
  let localRecord = null
  let recordAlreadyExisted = false
  try {
    localRecord = JSON.parse(await readFile(localRecordPath, 'utf8'))
    recordAlreadyExisted = true
    if (localRecord.fingerprint !== requestFingerprint) {
      throw new CliError('这个幂等编号已在本机用于其他参数。', 'IDEMPOTENCY_CONFLICT')
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error?.code !== 'ENOENT') throw new CliError('本机幂等记录损坏。', 'IDEMPOTENCY_RECORD_INVALID')
    localRecord = { fingerprint: requestFingerprint, idem, instanceId, method, bridgeId, createdAt: Date.now() }
    await writePrivateJson(localRecordPath, localRecord)
  }

  if (recordAlreadyExisted && localRecord.callId) {
    try {
      const previous = await fetchJson(`/v1/calls/${encodeURIComponent(localRecord.callId)}`, { token: profile.clientToken })
      const status = previous.value.status
      if (status === 'expired' && !canReplayAfterBridgeRestart(method)) {
        throw unknownMutationOutcome(method)
      }
      if (['completed', 'failed', 'cancelled', 'expired'].includes(status)) {
        const retrySend = isDurableSend(method) && ['failed', 'cancelled', 'expired'].includes(status)
        const cancelledAfterDelivery = status === 'cancelled' &&
          previous.value.deliveredAt !== undefined && previous.value.deliveredAt !== null
        if (cancelledAfterDelivery && !canReplayAfterBridgeRestart(method)) {
          throw unknownMutationOutcome(method)
        }
        if (!retrySend) {
          printJson(previous.value)
          if (status !== 'completed') process.exitCode = 2
          return
        }
      } else {
        const previousResult = await pollCall(localRecord.callId, profile.clientToken, options.timeoutMs)
        printJson(previousResult)
        if (previousResult.status !== 'completed') process.exitCode = 2
        return
      }
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'NOT_FOUND') throw error
      if (!canReplayAfterBridgeRestart(method)) throw unknownMutationOutcome(method)
    }
  } else if (
    recordAlreadyExisted &&
    localRecord.submitAttemptedAt &&
    localRecord.bridgeId !== bridgeId &&
    !canReplayAfterBridgeRestart(method)
  ) {
    throw unknownMutationOutcome(method)
  }

  localRecord.bridgeId = bridgeId
  localRecord.submitAttemptedAt = Date.now()
  await writePrivateJson(localRecordPath, localRecord)
  let response
  try {
    response = await fetchJson('/v1/calls', {
      method: 'POST',
      token: profile.clientToken,
      body: { instanceId, method, params, idempotencyKey: idem },
    })
  } catch (error) {
    if (error instanceof CliError && error.code !== 'BRIDGE_UNREACHABLE') {
      delete localRecord.submitAttemptedAt
      await writePrivateJson(localRecordPath, localRecord)
    }
    throw error
  }
  const callId = response.value.callId
  if (callId) {
    localRecord.callId = callId
    await writePrivateJson(localRecordPath, localRecord)
  }
  const result = await pollCall(callId, profile.clientToken, options.timeoutMs)
  printJson(result)
  if (result.status !== 'completed') process.exitCode = 2
}

function isDurableSend(method) {
  return method === 'sessions.send' || method === 'participants.send' || method === 'connect.submit'
}

function canReplayAfterBridgeRestart(method) {
  return isDurableSend(method) || [
    'models.list',
    'agents.list',
    'sessions.list',
    'tasks.get',
    'tasks.wait',
    'participants.list',
    'inbox.list',
    'sessions.read',
  ].includes(method)
}

function unknownMutationOutcome(method) {
  return new CliError(
    `无法确认 ${method} 是否已执行；请先用 sessions.list 或 tasks.get 检查业务状态，再用新的 --idem 决定下一步。`,
    'OUTCOME_UNKNOWN',
    2,
  )
}

async function pollCall(callId, clientToken, timeoutValue) {
  if (!callId) throw new CliError('需要 --request-id 才能查询原桥接请求。', 'REQUEST_ID_REQUIRED')
  const timeoutMs = parseTimeout(timeoutValue)
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const { value } = await fetchJson(`/v1/calls/${encodeURIComponent(callId)}`, { token: clientToken })
    if (['completed', 'failed', 'cancelled', 'expired'].includes(value.status)) {
      return value
    }
    await delay(400)
  }
  return { callId, status: 'waiting', message: '调用仍在排队或处理中；用 --request-id 可继续查同一请求。' }
}

async function commandTask(subcommand, taskId, options) {
  if (!taskId || !/^[a-z0-9._:-]{1,160}$/i.test(taskId)) throw new CliError('请提供有效的 taskId。', 'TASK_ID_REQUIRED')
  const params = await readParams(options)
  params.taskId = taskId
  const method = subcommand === 'wait' ? 'tasks.wait' : subcommand === 'answer' ? 'tasks.answer' : 'tasks.cancel'
  if (subcommand === 'wait' && params.timeoutMs === undefined) params.timeoutMs = Math.min(parseTimeout(options.timeoutMs), 25_000)
  return commandCall(method, { ...options, params, paramsProvided: true })
}

async function commandWait(taskId, options) {
  const instanceId = requiredOption(options, 'instance')
  const totalTimeout = parseTimeout(options.timeoutMs)
  const deadline = Date.now() + totalTimeout
  const invocationId = randomUUID()
  let attempt = 0
  while (Date.now() <= deadline) {
    const remaining = Math.min(25_000, Math.max(1_000, deadline - Date.now()))
    const base = options.idem || `wait-${taskId}`
    const loopOptions = {
      ...options,
      timeoutMs: remaining + 10_000,
      idem: `${base}/${invocationId}/${attempt}`,
      params: { ...(options.params || {}), taskId, timeoutMs: remaining },
      paramsProvided: true,
    }
    const output = await executeTaskCallAndReturn('tasks.wait', loopOptions, taskId, instanceId)
    if (output?.status === 'waiting') {
      printJson({ taskId, ...output })
      process.exitCode = 2
      return
    }
    if (output?.status === 'failed' || output?.status === 'cancelled' || output?.status === 'expired') {
      printJson(output)
      process.exitCode = 2
      return
    }
    if (output?.status === 'completed' || output?.status === 'done' || output?.status === 'succeeded') {
      printJson(output)
      return
    }
    if (output?.status === 'waiting_dependency' && output.tasks?.some((task) =>
      ['waiting_user', 'interrupted'].includes(task.status))) {
      printJson(output)
      return
    }
    if (!output || !['running', 'pending', 'queued', 'waiting_dependency'].includes(output.status)) {
      printJson(output)
      return
    }
    attempt += 1
  }
  printJson({ taskId, status: 'waiting', message: '任务仍在运行；再次运行 wait <taskId> 可继续等它。' })
  process.exitCode = 2
}

async function executeTaskCallAndReturn(method, options) {
  const instanceId = requiredOption(options, 'instance')
  const profile = await readClientProfile(requiredOption(options, 'client'))
  if (profile.instanceId !== instanceId) throw new CliError('所选客户端不属于这个实例，请检查 --instance。', 'INSTANCE_MISMATCH')
  const idem = options.idem
  const rawParams = options.paramsProvided ? options.params : await readParams(options)
  const params = withBusinessIdempotencyKey(method, rawParams, idem)
  const fingerprint = hash(`${instanceId}\n${method}\n${stableStringify(params)}`)
  const localPath = callRecordPath(profile.clientId, instanceId, idem)
  let record
  try {
    record = JSON.parse(await readFile(localPath, 'utf8'))
    if (record.fingerprint !== fingerprint) throw new CliError('这个幂等编号已用于其他任务参数。', 'IDEMPOTENCY_CONFLICT')
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error?.code !== 'ENOENT') throw error
    record = { fingerprint, idem, instanceId, method, createdAt: Date.now() }
    await writePrivateJson(localPath, record)
  }
  if (record.callId) {
    try {
      const existing = await fetchJson(`/v1/calls/${encodeURIComponent(record.callId)}`, { token: profile.clientToken })
      if (existing.value.status === 'expired') {
        delete record.callId
        await writePrivateJson(localPath, record)
      } else if (['completed', 'failed', 'cancelled'].includes(existing.value.status)) {
        return existing.value.status === 'completed'
          ? existing.value.result ?? { status: 'completed', taskId: options.taskId }
          : { status: existing.value.status, taskId: options.taskId, error: existing.value.error }
      } else {
        const waiting = await pollCall(record.callId, profile.clientToken, options.timeoutMs)
        if (waiting.status === 'waiting') return { ...waiting, requestId: record.callId }
        if (waiting.status === 'completed') return waiting.result ?? { status: 'completed', taskId: options.taskId }
        return { status: waiting.status, taskId: options.taskId, error: waiting.error }
      }
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'NOT_FOUND') throw error
      // The broker's short-lived transport cache may have been lost on restart.
      // Reissue the same business idempotency key so UNagent can return the
      // original durable task instead of creating a duplicate.
      delete record.callId
      await writePrivateJson(localPath, record)
    }
  }
  if (!record.callId) {
    const { value } = await fetchJson('/v1/calls', {
      method: 'POST',
      token: profile.clientToken,
      body: { instanceId, method, params, idempotencyKey: idem },
    })
    record.callId = value.callId
    await writePrivateJson(localPath, record)
  }
  const value = await pollCall(record.callId, profile.clientToken, options.timeoutMs)
  if (value.status === 'waiting') return { ...value, requestId: record.callId }
  if (value.status === 'completed') return value.result ?? { status: 'completed', taskId: options.taskId }
  if (value.status === 'failed') return { status: 'failed', taskId: options.taskId, error: value.error }
  return { status: value.status, taskId: options.taskId }
}

async function readClientProfile(name) {
  const profilePath = clientProfilePath(name)
  let value
  try {
    value = JSON.parse(await readFile(profilePath, 'utf8'))
  } catch {
    throw new CliError(`找不到客户端配置「${name}」；先运行 client-register。`, 'CLIENT_NOT_REGISTERED')
  }
  if (!value.clientToken || !value.clientId || !value.instanceId) throw new CliError('客户端配置还没有完成注册。', 'CLIENT_NOT_REGISTERED')
  return value
}

function clientProfilePath(name) {
  const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  const normalized = slug.replace(/^-+|-+$/g, '').slice(0, 48) || 'client'
  return path.join(HOME, 'clients', `${normalized}-${hash(String(name)).slice(0, 8)}.json`)
}

function callRecordPath(clientId, instanceId, idem) {
  const key = hash(`${clientId}:${instanceId}:${idem}`)
  return path.join(HOME, 'calls', `${key}.json`)
}

async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(filePath), 0o700)
  const temp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, filePath)
  await chmod(filePath, 0o600)
}

async function readParams(options) {
  if (options.paramsProvided) return options.params
  if (options.paramsFile === undefined) return {}
  const raw = options.paramsFile === '-'
    ? await readStdin()
    : await readFile(path.resolve(options.paramsFile), 'utf8')
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new CliError(`参数文件上限为 ${MAX_BODY_BYTES} 字节。`, 'PAYLOAD_TOO_LARGE')
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value
  } catch {
    throw new CliError('业务参数必须是 JSON 对象。', 'PARAMS_INVALID')
  }
}

function parseArgs(argv) {
  const positionals = []
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const [key, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) options[camel(key)] = inline
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) options[camel(key)] = argv[++i]
    else options[camel(key)] = true
  }
  return { positionals, options }
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

function requiredOption(options, key) {
  const value = options[key]
  if (typeof value !== 'string' || !value.trim()) throw new CliError(`缺少 --${key.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)}。`, 'OPTION_REQUIRED')
  return value.trim()
}

function parseTimeout(value) {
  if (value === undefined) return 120_000
  const ms = Number(value)
  if (!Number.isInteger(ms) || ms < 100 || ms > 600_000) throw new CliError('--timeout-ms 必须在 100 到 600000 之间。', 'TIMEOUT_INVALID')
  return ms
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? 'null').join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function withBusinessIdempotencyKey(method, params, idem) {
  if (!['sessions.send', 'participants.send', 'connect.submit', 'inbox.claim', 'inbox.complete', 'inbox.fail'].includes(method)) return params
  const existing = params.idempotencyKey
  if (existing !== undefined && existing !== idem) {
    throw new CliError('params.idempotencyKey 必须与 --idem 使用同一个编号。', 'IDEMPOTENCY_CONFLICT')
  }
  return { ...params, idempotencyKey: idem }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    process.stdin.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new CliError(`参数输入上限为 ${MAX_BODY_BYTES} 字节。`, 'PAYLOAD_TOO_LARGE'))
        process.stdin.pause()
      } else chunks.push(chunk)
    })
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

async function commandHeartbeat(options) {
  const params = await readParams(options)
  if (typeof params.taskId !== 'string' || !params.taskId || typeof params.executionToken !== 'string' || !params.executionToken) {
    throw new CliError('heartbeat 需要参数文件或 stdin 提供 taskId 和 executionToken。', 'PARAMS_INVALID')
  }
  const instance = requiredOption(options, 'instance')
  const client = requiredOption(options, 'client')
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  process.stderr.write(JSON.stringify({ heartbeat: 'started', pid: process.pid, stop: 'SIGINT/SIGTERM', maxDurationMs: Number(options.durationMs ?? 900_000) }) + '\n')
  try {
    const result = await runHeartbeat({
      beat: signal => heartbeatCall(fileURLToPath(import.meta.url), { instance, client, params }, signal),
      signal: abort.signal,
      durationMs: Number(options.durationMs ?? 900_000),
    })
    printJson(result)
  } catch (error) {
    if (abort.signal.aborted) printJson({ stopped: true, reason: 'signal' })
    else throw error
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

function help() {
  process.stdout.write([
    'UNagent local bridge CLI',
    '',
    '  start',
    '  start [--port PORT | --address http://127.0.0.1:PORT]',
    '  status',
    '  stop',
    '  pair-code',
    '  client-register --name STABLE_NAME [--purpose PURPOSE] [--profile PROFILE] [--code-file PATH|-] [--replace]',
    '  list-instances',
    '  call METHOD --instance ID --client NAME --idem KEY [--params-file PATH|-] [--timeout-ms MS]',
    '  call --request-id ID --instance ID --client NAME [--timeout-ms MS]',
    '  heartbeat --instance ID --client NAME --params-file FILE|- [--duration-ms MS]',
    '  wait TASK_ID --instance ID --client NAME [--timeout-ms MS] [--idem KEY]',
    '  answer TASK_ID --instance ID --client NAME --params-file PATH --idem KEY',
    '  cancel TASK_ID --instance ID --client NAME --idem KEY',
    '',
    'All output is JSON. The bridge listens on 127.0.0.1 (default port 27123).',
  ].join('\n') + '\n')
}

async function readPairCode(options) {
  if (options.code !== undefined) return requiredOption(options, 'code')
  if (options.codeFile !== undefined) {
    const raw = options.codeFile === '-'
      ? await readStdin()
      : await readFile(path.resolve(options.codeFile), 'utf8')
    return raw.trim()
  }
  if (process.stdin.isTTY) {
    const terminal = createInterface({ input: process.stdin, output: process.stderr })
    try {
      return (await terminal.question('粘贴 5 分钟内有效的客户端配对码：')).trim()
    } finally {
      terminal.close()
    }
  }
  return (await readStdin()).trim()
}

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2))
  const [command, arg] = positionals
  if (!['help', '--help', undefined].includes(command)) await configureAddress(command, options)
  switch (command) {
    case 'start': return commandStart(options)
    case 'status': return commandStatus()
    case 'stop': return commandStop()
    case 'pair-code': return commandPairCode()
    case 'list-instances': return commandListInstances()
    case 'client-register': return commandClientRegister(options)
    case 'call':
      if (arg) return commandCall(arg, options)
      if (options.requestId) {
        await ensureStarted()
        const profile = await readClientProfile(requiredOption(options, 'client'))
        if (profile.instanceId !== requiredOption(options, 'instance')) throw new CliError('所选客户端不属于这个实例。', 'INSTANCE_MISMATCH')
        const value = await pollCall(options.requestId, profile.clientToken, options.timeoutMs)
        printJson(value)
        if (value.status !== 'completed') process.exitCode = 2
        return
      }
      throw new CliError('call 后需要业务方法名；支持的列表见 reference/bridge-protocol.md。', 'METHOD_REQUIRED')
    case 'heartbeat': return commandHeartbeat(options)
    case 'wait': return commandWait(arg, options)
    case 'answer': return commandTask('answer', arg, options)
    case 'cancel': return commandTask('cancel', arg, options)
    case '--help':
    case 'help':
    case undefined: return help()
    default: throw new CliError(`未知命令：${command}`, 'COMMAND_UNKNOWN')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(printError)
}
