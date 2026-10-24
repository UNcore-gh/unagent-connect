#!/usr/bin/env node
import { readFile, readdir, lstat, mkdir, writeFile, copyFile, chmod } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
const roots = ['LICENSE', 'VERSION', 'README.md', 'SKILL.md', 'INSTALL.md', 'package.json', 'agents/openai.yaml', 'bin/connect.mjs', 'scripts/install.mjs', 'scripts/unagent-connect', 'scripts/unagent-connect.mjs', 'scripts/bridge-server.mjs', 'scripts/heartbeat.mjs']
const forbidden = file => file.split('/').some(s => s.startsWith('.') || /^(data|logs?|state|credentials?|test|tests|__tests__|coverage|examples)$/i.test(s) || s === 'data.json' || /\.(log|env|token|sqlite|db|map)$/i.test(s))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function regular(file) {
  const st = await lstat(file)
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Non-regular distribution source: ${path.basename(file)}`)
  return st
}
export async function sourceFiles() {
  const files = [...roots]
  async function walk(directory, accept) {
    for (const ent of await readdir(path.join(ROOT, directory), { withFileTypes: true })) {
      const file = directory + '/' + ent.name
      if (forbidden(file)) continue
      if (ent.isSymbolicLink()) throw new Error('Distribution symlink refused')
      if (ent.isDirectory()) await walk(file, accept)
      else if (accept(file)) files.push(file)
    }
  }
  await walk('src', f => f.endsWith('.mjs'))
  await walk('reference', f => f.endsWith('.md'))
  await walk('docs', f => f.endsWith('.md'))
  for (const file of files) await regular(path.join(ROOT, file))
  return files.sort()
}
/** Resolve installed runtime dependency closure; no npm lifecycle scripts or downloads. */
async function dependencyFiles(adapters = []) {
  const files = new Map(), visited = new Set()
  const project = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  async function dependency(name, from, optional = false) {
    let manifest
    // Resolve manifests without relying on package exports of native SDKs.
    const search = createRequire(path.join(from, 'package.json')).resolve.paths(name) || []
    for (const base of search) {
      const candidate = path.join(base, name, 'package.json')
      try { await regular(candidate); manifest = candidate; break } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    if (!manifest) { if (optional) return; throw new Error(`Missing runtime dependency ${name}; ask controller to install dependencies`) }
    const directory = path.dirname(manifest)
    if (!directory.startsWith(path.join(ROOT, 'node_modules') + path.sep)) throw new Error(`Dependency outside project: ${name}`)
    if (visited.has(directory)) return
    visited.add(directory)
    const meta = JSON.parse(await readFile(manifest, 'utf8'))
    async function walk(dir) {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules') continue
        const absolute = path.join(dir, ent.name), relative = path.relative(ROOT, absolute).split(path.sep).join('/')
        if (forbidden(relative)) continue
        if (ent.isSymbolicLink()) throw new Error('Dependency symlink refused')
        if (ent.isDirectory()) await walk(absolute)
        else {
          const st = await regular(absolute)
          if (/\.(?:[cm]?js|json|wasm|node|exe|dll|so|dylib|pem|crt|md|txt|ts)$/i.test(ent.name) || /^(LICENSE|NOTICE|COPYING)/i.test(ent.name) || (st.mode & 0o111)) files.set(relative, absolute)
        }
      }
    }
    await walk(directory)
    for (const key of Object.keys(meta.dependencies || {})) await dependency(key, directory, Boolean(meta.optionalDependencies?.[key]))
    for (const key of Object.keys(meta.optionalDependencies || {})) await dependency(key, directory, true)
    for (const key of Object.keys(meta.peerDependencies || {})) await dependency(key, directory, Boolean(meta.peerDependenciesMeta?.[key]?.optional))
  }
  for (const name of Object.keys(project.dependencies || {})) await dependency(name, ROOT)
  if (adapters.includes('claude')) await dependency('@anthropic-ai/claude-agent-sdk', ROOT)
  return files
}
export async function packageProject({ out, withDependencies = true, adapters = [] } = {}) {
  if (!Array.isArray(adapters) || adapters.some(x => x !== 'claude')) throw new Error('Only optional runtime selection --adapters claude is supported')
  const dest = path.resolve(out || path.join(ROOT, 'dist'), 'unagent-connect')
  // Never overwrite a build tree or local edits; a caller chooses a new output directory.
  try { await lstat(dest); throw new Error('Output already exists; choose an empty --out directory') } catch (e) { if (e.code !== 'ENOENT') throw e }
  const projectFiles = await sourceFiles()
  const files = new Map(projectFiles.map(file => [file, path.join(ROOT, file)]))
  if (withDependencies) for (const [file, source] of await dependencyFiles(adapters)) files.set(file, source)
  await mkdir(dest, { recursive: true })
  const checksums = []
  for (const [file, source] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (forbidden(file)) throw new Error('Forbidden distribution path')
    const target = path.join(dest, file)
    await mkdir(path.dirname(target), { recursive: true })
    const bytes = await readFile(source)
    await writeFile(target, bytes, { mode: (await lstat(source)).mode & 0o777 })
    checksums.push(`${digest(bytes)}  ${file}`)
  }
  await writeFile(path.join(dest, 'SHA256SUMS'), checksums.join('\n') + '\n')
  await chmod(path.join(dest, 'bin/connect.mjs'), 0o755)
  return { directory: dest, files: files.size, dependencies: withDependencies }
}
export async function packageMain(args = process.argv.slice(2)) {
  if (args.includes('--check')) {
    await sourceFiles()
    // Parsing the legacy distribution manifest catches accidental path drift without writing anything.
    const bytes = await readFile(path.join(ROOT, 'scripts/install.mjs'), 'utf8')
    if (!bytes.includes('SHA256SUMS')) throw new Error('Installer must verify checksums')
    process.stdout.write('Distribution sources OK\n'); return
  }
  const outIndex = args.indexOf('--out')
  if (outIndex >= 0 && !args[outIndex + 1]) throw new Error('--out requires a path')
  const adapterIndex = args.indexOf('--adapters')
  const adapters = adapterIndex < 0 ? [] : (args[adapterIndex+1] || '').split(',').filter(Boolean)
  if (adapterIndex >= 0 && !adapters.length) throw new Error('--adapters requires claude')
  const result = await packageProject({ out: outIndex < 0 ? undefined : args[outIndex + 1], adapters })
  process.stdout.write(JSON.stringify(result) + '\n')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageMain().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1 })
