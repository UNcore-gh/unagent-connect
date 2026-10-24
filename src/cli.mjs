import path from 'node:path'
import os from 'node:os'
import { readFile, access, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createClient, readToken, localURL } from './client.mjs'
import { DEFAULT_STATE_DIR } from './server.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
function flags(args, allowed) {
  const result = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new Error(`未知或重复选项: ${key}`)
    if (key === '--apply') { result[key] = true; continue }
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`选项缺值: ${key}`)
    result[key] = args[++i]
  }
  return result
}
export async function readParams(file = '-', stdin = process.stdin) {
  let text
  if (file === '-') {
    const chunks = []; let size = 0
    for await (const chunk of stdin) { size += Buffer.byteLength(chunk); if (size > 1024 * 1024) throw new Error('参数超过 1MiB'); chunks.push(Buffer.from(chunk)) }
    text = Buffer.concat(chunks).toString('utf8')
  } else {
    text = await readFile(file, 'utf8')
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('参数超过 1MiB')
  }
  const params = text.trim() ? JSON.parse(text) : {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('参数必须是 JSON 对象')
  return params
}
async function child(script, args) {
  return await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, script), ...args], { stdio: 'inherit', shell: false })
    p.once('error', reject); p.once('exit', (code, signal) => signal ? reject(new Error(`子进程停止: ${signal}`)) : resolve(code ?? 1))
  })
}
async function adaptersForStartup() {
  const { createAdapters } = await import('./adapters/index.mjs')
  return createAdapters()
}
export async function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, adapters } = {}) {
  const [command, ...args] = argv
  const [major,minor]=process.versions.node.split('.').map(Number)
  if(command!=='legacy'&&(major<22||major===22&&minor<13))throw new Error('UNagent Connect Hub 需要 Node.js 22.13 或更新版本；旧版脚本仍可单独使用。')
  if (!command || ['help', '--help', '-h'].includes(command)) {
    out.write('UNagent Connect\n  serve [--port N] [--state-dir PATH]\n  status [--url URL]\n  rpc METHOD [--params-file PATH|-] [--token-file PATH] [--url URL]\n  mcp [--token-file PATH] [--url URL]\n  install [--target codex|claude|other] [--target-dir PATH] [--apply]\n  legacy ... (原 0.1.1 CLI 与配对)\n'); return 0
  }
  if (command === 'legacy') return await child('scripts/unagent-connect.mjs', args)
  if (command === 'install') {
    const options = flags(args, ['--target', '--target-dir', '--apply'])
    if (options['--target'] && !['codex','claude','other'].includes(options['--target'])) throw new Error('安装目标无效')
    if (!options['--target-dir'] && !['codex','claude'].includes(options['--target'])) throw new Error('请指定 --target codex|claude 或 --target-dir')
    const sourceCheckout = await access(path.join(root, 'scripts/package.mjs')).then(() => true, () => false)
    if (!sourceCheckout) return await child('scripts/install.mjs', args)
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'unagent-connect-install-'))
    try {
      const { packageProject } = await import('../scripts/package.mjs')
      const built = await packageProject({ out: temporary })
      return await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [path.join(built.directory,'scripts/install.mjs'), ...args], {stdio:'inherit',shell:false})
        p.once('error',reject);p.once('exit',code=>resolve(code??1))
      })
    } finally { await rm(temporary, {recursive:true,force:true}) }
  }
  if (command === 'serve') {
    const options = flags(args, ['--port', '--state-dir'])
    const port = options['--port'] === undefined ? 18492 : Number(options['--port'])
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效')
    const stateDir = path.resolve(options['--state-dir'] || DEFAULT_STATE_DIR)
    const { Hub } = await import('./core/hub.mjs')
    const { createHubServer } = await import('./server.mjs')
    const hub = new Hub({ stateDir, adapters: adapters ?? await adaptersForStartup() })
    const server = createHubServer({ hub, stateDir, port })
    try { await server.listen() } catch (e) { await hub.close(); throw e }
    out.write(JSON.stringify({ url: server.origin, connectionFile: path.join(stateDir, 'connection.json') }) + '\n')
    let stopping = false
    const stop = async () => { if (stopping) return; stopping = true; await server.close(); await hub.close() }
    process.once('SIGINT', () => { void stop().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1 }) })
    process.once('SIGTERM', () => { void stop().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1 }) })
    return 0
  }
  if (command === 'status') {
    const options = flags(args, ['--url'])
    const response = await fetch(localURL(options['--url'] || env.UNAGENT_CONNECT_URL) + '/v1/health', { redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('本机服务未就绪')
    out.write(JSON.stringify(await response.json()) + '\n'); return 0
  }
  if (command === 'rpc' || command === 'mcp') {
    const method = command === 'rpc' ? args.shift() : undefined
    if (command === 'rpc' && (!method || method.startsWith('--'))) throw new Error('需要 RPC 方法名')
    const options = flags(args, command === 'rpc' ? ['--params-file', '--token-file', '--url'] : ['--token-file', '--url'])
    const tokenFile = options['--token-file'] || env.UNAGENT_CONNECT_TOKEN_FILE
    const token = tokenFile ? await readToken(tokenFile) : env.UNAGENT_CONNECT_TOKEN
    const client = createClient({ url: options['--url'] || env.UNAGENT_CONNECT_URL, token, mcp: command === 'mcp' })
    if (command === 'rpc') out.write(JSON.stringify(await client.call(method, await readParams(options['--params-file'] || '-'))) + '\n')
    else {
      if (!token) throw new Error('MCP 需要参与者令牌')
      const { startMcp } = await import('./mcp.mjs'); await startMcp({ client, env })
    }
    return 0
  }
  throw new Error('未知命令；使用 help 查看说明。旧版命令请加 legacy，或直接运行 scripts/unagent-connect。')
}
