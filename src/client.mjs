import { readFile, lstat } from 'node:fs/promises'

export function localURL(value = 'http://127.0.0.1:18492') {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('需要 http://127.0.0.1:端口 本机地址')
  return url.origin
}
export async function readToken(file) {
  const st = await lstat(file)
  if (st.isSymbolicLink() || !st.isFile() || (process.platform !== 'win32' && (st.mode & 0o077))) throw new Error('令牌文件必须是权限 600 的普通文件')
  const text = (await readFile(file, 'utf8')).trim()
  let token = text
  if (text.startsWith('{')) { const data = JSON.parse(text); token = data.token || data.participantToken; }
  if (typeof token !== 'string' || !token || /\s/.test(token)) throw new Error('参与者令牌无效；不接受管理员连接文件')
  return token
}
export function createClient({ url, token, mcp = false, fetchImpl = fetch } = {}) {
  const base = localURL(url)
  return {
    async call(method, params = {}, { signal } = {}) {
      if (!token || typeof token !== 'string' || /\s/.test(token)) throw new Error('需要参与者令牌')
      const response = await fetchImpl(base + '/v1/rpc', { method: 'POST', redirect: 'error', signal: signal || AbortSignal.timeout(35000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(mcp ? { 'X-UNagent-Connect-Client': 'mcp' } : {}) }, body: JSON.stringify({ method, params }) })
      const text = await response.text()
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('响应过大')
      const data = JSON.parse(text)
      if (!response.ok || !data.ok) throw Object.assign(new Error(data.error?.message || 'RPC 失败'), { code: data.error?.code || 'HTTP_ERROR' })
      return data.result
    },
  }
}
