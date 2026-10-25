import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, lstat, writeFile, rename, readFile, unlink, chmod } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { UI_HTML, UI_JS, UI_CSS } from './ui.mjs'

export const MAX_BODY_BYTES = 1024 * 1024
export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.unagent', 'connect')
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status })
const id = () => randomBytes(32).toString('hex')
const cursor = value => {
  if (value === null || value === undefined || value === '') return 0
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw fail('BAD_CURSOR', '游标无效')
  return Number(value)
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail('CONTENT_TYPE', '需要 application/json', 415)
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw fail('BODY_TOO_LARGE', '请求超过 1MiB', 413)
  const chunks = []; let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) { req.resume(); throw fail('BODY_TOO_LARGE', '请求超过 1MiB', 413) }
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch { throw fail('BAD_JSON', 'JSON 对象无效') }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Hub owns authorization and state; transport never fabricates participant actors. */
export function createHubServer({ hub, port = 18492, stateDir = DEFAULT_STATE_DIR, version = '0.2.1', maxStreams = 32, streamLifetimeMs = 300000 } = {}) {
  if (!hub || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid hub/port')
  let origin, connectionFile, connectionBytes
  const sessions = new Map(), streams = new Set()
  let loginWindow = 0, loginAttempts = 0
  async function auth(req) {
    const authorization = req.headers.authorization
    if (authorization) {
      const match = /^Bearer ([^\s]+)$/.exec(authorization)
      if (!match) throw fail('UNAUTHORIZED', '认证失败', 401)
      const actor = await hub.authenticate(match[1])
      if (!actor || (!actor.admin && !actor.participantId)) throw fail('UNAUTHORIZED', '认证失败', 401)
      // MCP is always participant scoped, even if accidentally configured with admin credentials.
      if (actor.admin && (req.headers.origin === 'app://obsidian.md' || req.headers['x-unagent-connect-client'] === 'mcp')) throw fail('FORBIDDEN', 'MCP 不接受管理员凭据', 403)
      return actor
    }
    if (req.headers.origin === 'app://obsidian.md') throw fail('UNAUTHORIZED', '插件连接必须使用参与者凭据', 401)
    const key = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('connect_session='))?.slice(16)
    const session = sessions.get(key)
    if (!session || session.expires < Date.now()) { sessions.delete(key); throw fail('UNAUTHORIZED', '请先登录', 401) }
    const actor = await hub.authenticate(session.token)
    if (!actor?.admin) { sessions.delete(key); throw fail('UNAUTHORIZED', '登录已失效', 401) }
    if (req.method !== 'GET' && req.headers.origin !== origin) throw fail('CSRF', '需要同源请求', 403)
    return actor
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    try {
      if (req.socket.remoteAddress !== '127.0.0.1') throw fail('LOOPBACK_ONLY', '仅允许本机', 403)
      if (req.headersDistinct.host?.length !== 1 || req.headersDistinct.origin?.length > 1 || req.headers.host !== new URL(origin).host) throw fail('BAD_HOST', 'Host 不匹配', 403)
      const pluginOrigin = req.headers.origin === 'app://obsidian.md'
      if (req.headers.origin !== undefined && req.headers.origin !== origin && !pluginOrigin) throw fail('BAD_ORIGIN', 'Origin 不匹配', 403)
      if (req.headers['sec-fetch-site'] === 'cross-site' && !pluginOrigin) throw fail('BAD_ORIGIN', '拒绝跨站请求', 403)
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw fail('BAD_PATH', '路径无效')
      const url = new URL(req.url, origin)
      if (pluginOrigin) {
        if (url.pathname !== '/v1/rpc' || !['OPTIONS','POST'].includes(req.method)) throw fail('FORBIDDEN','插件仅能调用业务接口',403)
        res.setHeader('Access-Control-Allow-Origin','app://obsidian.md')
        res.setHeader('Vary','Origin')
        if (req.method === 'OPTIONS') {
          const names=(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean)
          if (req.headers['access-control-request-method'] !== 'POST' || names.some(x=>!['authorization','content-type'].includes(x))) throw fail('FORBIDDEN','不支持的插件预检',403)
          res.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'authorization,content-type'});res.end();return
        }
      }
      if (req.method === 'GET' && url.pathname === '/v1/health') return json(res, 200, { version })
      const assets = { '/': ['text/html', UI_HTML], '/ui.js': ['text/javascript', UI_JS], '/ui.css': ['text/css', UI_CSS] }
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [type, content] = assets[url.pathname]; res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); return res.end(content)
      }
      if (req.method === 'POST' && url.pathname === '/v1/login') {
        if (req.headers.origin !== origin) throw fail('CSRF', '需要同源登录', 403)
        if (Date.now() - loginWindow > 60000) { loginWindow = Date.now(); loginAttempts = 0 }
        if (++loginAttempts > 30) throw fail('RATE_LIMIT', '请稍后重试', 429)
        const { token } = await body(req)
        if (typeof token !== 'string' || !(await hub.authenticate(token))?.admin) throw fail('UNAUTHORIZED', '管理员令牌无效', 401)
        for (const [key, s] of sessions) if (s.expires < Date.now()) sessions.delete(key)
        if (sessions.size >= 128) sessions.delete(sessions.keys().next().value)
        const key = id(); sessions.set(key, { token, expires: Date.now() + 8 * 3600000 })
        res.setHeader('Set-Cookie', `connect_session=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`)
        return json(res, 200, { ok: true })
      }
      const actor = await auth(req)
      if (req.method === 'POST' && url.pathname === '/v1/logout') {
        // Same-origin guard also applies to bearer logout.
        if (req.headers.origin !== origin) throw fail('CSRF', '需要同源请求', 403)
        const key = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('connect_session='))?.slice(16)
        sessions.delete(key); res.setHeader('Set-Cookie', 'connect_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/v1/rpc') {
        const input = await body(req)
        if (typeof input.method !== 'string' || !input.params || typeof input.params !== 'object' || Array.isArray(input.params) || Object.keys(input).some(k => !['method', 'params'].includes(k))) throw fail('BAD_RPC', '需要 {method,params}')
        return json(res, 200, { ok: true, result: await hub.call(input.method, input.params, actor) })
      }
      if (req.method === 'GET' && ['/v1/events', '/v1/events/stream'].includes(url.pathname)) {
        let after = cursor(req.headers['last-event-id'] ?? url.searchParams.get('after'))
        const runId = url.searchParams.get('runId') || undefined
        const snapshot = async () => {
          const batch = await hub.events(after, actor, runId)
          if (!batch || !Array.isArray(batch.events) || batch.events.length > 1000 || Buffer.byteLength(JSON.stringify(batch)) > MAX_BODY_BYTES) throw fail('EVENT_LIMIT', '事件批次过大', 503)
          cursor(batch.nextCursor)
          return batch
        }
        if (url.pathname === '/v1/events') return json(res, 200, { ok: true, result: await snapshot() })
        if (streams.size >= maxStreams) throw fail('STREAM_LIMIT', '事件连接已达上限', 429)
        // Validate before sending headers; replay uses the same filtered cursor API.
        let initial = await snapshot()
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
        let closed = false, busy = false, dirty = false, unsubscribe = () => {}
        const send = batch => {
          after = batch.nextCursor
          if (!res.write(`id: ${after}\nevent: hub\ndata: ${JSON.stringify(batch)}\n\n`)) stop()
        }
        const stop = () => {
          if (closed) return
          closed = true; clearInterval(heartbeat); clearTimeout(expiry); unsubscribe(); streams.delete(stop); res.end()
        }
        const flush = async () => {
          if (closed) return
          if (busy) { dirty = true; return }
          busy = true
          try {
            do {
              dirty = false
              // Re-authenticate to fence revoked participant tokens during a live stream.
              await auth(req)
              const batch = await snapshot()
              if (batch.events.length || batch.nextCursor !== after) send(batch)
            } while (dirty && !closed)
          } catch { stop() } finally { busy = false }
        }
        const heartbeat = setInterval(() => { if (!res.write(': keepalive\n\n')) stop(); else void flush() }, 15000)
        const expiry = setTimeout(stop, streamLifetimeMs)
        streams.add(stop); res.on('close', stop)
        unsubscribe = hub.subscribe?.(() => void flush()) || (() => {})
        send(initial); initial = null; void flush()
        return
      }
      throw fail('NOT_FOUND', '接口不存在', 404)
    } catch (error) {
      if (res.headersSent) return res.end()
      const code = error.code || 'INTERNAL_ERROR'
      const status = error.status || (['UNAUTHORIZED', 'INVALID_TOKEN'].includes(code) ? 401 : code === 'FORBIDDEN' ? 403 : code === 'INTERNAL_ERROR' ? 500 : 400)
      json(res, status, { ok: false, error: { code, message: code === 'INTERNAL_ERROR' ? '本机服务内部错误' : error.message } })
    }
  })
  server.requestTimeout = 35000; server.headersTimeout = 10000; server.maxHeadersCount = 64
  return {
    server,
    get origin() { return origin },
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      origin = `http://127.0.0.1:${server.address().port}`
      hub.setUrl?.(origin)
      try {
        await mkdir(stateDir, { recursive: true, mode: 0o700 })
        if ((await lstat(stateDir)).isSymbolicLink()) throw new Error('State directory symlink refused')
        await chmod(stateDir, 0o700)
        connectionFile = path.join(stateDir, 'connection.json')
        try { if ((await lstat(connectionFile)).isSymbolicLink()) throw new Error('Connection symlink refused') } catch (e) { if (e.code !== 'ENOENT') throw e }
        connectionBytes = JSON.stringify({ url: origin, adminToken: hub.adminToken, pid: process.pid, version }) + '\n'
        const temp = connectionFile + '.' + id() + '.tmp'
        try { await writeFile(temp, connectionBytes, { mode: 0o600, flag: 'wx' }); await rename(temp, connectionFile) }
        finally { await unlink(temp).catch(() => {}) }
      } catch (e) { await new Promise(resolve => server.close(resolve)); throw e }
      return server.address()
    },
    async close() {
      for (const stop of [...streams]) stop()
      sessions.clear()
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections() })
      if (connectionFile && await readFile(connectionFile, 'utf8').catch(() => '') === connectionBytes) await unlink(connectionFile).catch(() => {})
    },
  }
}
export const createServer = createHubServer
