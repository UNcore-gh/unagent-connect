#!/usr/bin/env node
// Standalone Node.js tool; never bundled into the Obsidian plugin.
import process from 'node:process'
import { readFile, lstat, readdir, mkdir, copyFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const value = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
async function run() {
  const target = value('--target')
  if (!['codex', 'claude'].includes(target) && !value('--target-dir')) throw new Error('Use --target codex|claude or --target-dir SKILLS_DIRECTORY')
  const parent = path.resolve(value('--target-dir') || path.join(os.homedir(), target === 'codex' ? '.agents/skills' : '.claude/skills'))
  const dest = path.join(parent, 'unagent-connect')
  const entries = (await readFile(path.join(source, 'SHA256SUMS'), 'utf8')).trim().split('\n').map(line => {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line)
    if (!match || match[2].split('/').some(x => !x || x === '..' || x === '.') || path.isAbsolute(match[2]) || match[2].includes('\\')) throw new Error('Invalid checksum path')
    return { hash: match[1], file: match[2] }
  })
  const planned = new Set(entries.map(e => e.file))
  async function regular(base, file) {
    let current = base
    for (const segment of file.split('/')) {
      current = path.join(current, segment)
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink refused')
    }
    if (!(await lstat(current)).isFile()) throw new Error('Not a regular file')
    return readFile(current)
  }
  for (const entry of entries) {
    const bytes = await regular(source, entry.file)
    if (createHash('sha256').update(bytes).digest('hex') !== entry.hash) throw new Error(`Checksum mismatch: ${entry.file}`)
  }
  const changes = []
  let exists = false
  try { const st = await lstat(dest); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Destination is not a regular directory'); exists = true } catch (e) { if (e.code !== 'ENOENT') throw e }
  for (const entry of entries) {
    let old
    try { old = await regular(dest, entry.file) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (!old || createHash('sha256').update(old).digest('hex') !== entry.hash) changes.push({ file: entry.file, action: old ? 'modified' : 'added' })
  }
  if (exists) {
    async function walk(dir, prefix = '') {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const file = prefix + item.name
        if (item.isSymbolicLink()) throw new Error('Symlink refused')
        if (item.isDirectory()) await walk(path.join(dir, item.name), file + '/')
        else if (!planned.has(file) && file !== 'SHA256SUMS') changes.push({ file, action: 'local-only' })
      }
    }
    await walk(dest)
  }
  process.stdout.write(JSON.stringify({ version: '0.1.1', destination: dest, changes, mode: args.includes('--apply') ? 'apply' : 'diff' }) + '\n')
  if (!args.includes('--apply')) return
  if (exists) {
    if (changes.length) throw new Error('Existing installation differs; refusing overwrite. Review diff and choose an empty target directory.')
    return
  }
  await mkdir(parent, { recursive: true })
  const stage = await mkdtemp(path.join(parent, '.unagent-connect-'))
  try {
    for (const {file} of entries) {
      await mkdir(path.dirname(path.join(stage, file)), { recursive: true })
      await copyFile(path.join(source, file), path.join(stage, file))
    }
    await copyFile(path.join(source, 'SHA256SUMS'), path.join(stage, 'SHA256SUMS'))
    // Refuse replacing a concurrently created installation.
    await mkdir(dest)
    try { for (const file of await readdir(stage)) await rename(path.join(stage, file), path.join(dest, file)) }
    catch (e) { throw new Error(`Installation incomplete at ${dest}: ${e.message}`) }
  } finally { await rm(stage, { recursive: true, force: true }) }
}
run().catch(e => { process.stderr.write(String(e.message) + '\n'); process.exitCode = 1 })
