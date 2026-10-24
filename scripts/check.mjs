#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
async function walk(dir) {
  for (const ent of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, ent.name)
    if (ent.isDirectory()) await walk(file)
    else if (file.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' })
      if (result.status !== 0) throw new Error(`Syntax check failed: ${file}`)
    }
  }
}
try {
  for (const dir of ['src', 'bin', 'scripts', 'test']) await walk(dir)
  const tests = (await readdir(path.join(root, 'test'))).filter(x => x.endsWith('.test.mjs')).map(x => 'test/' + x)
  const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} catch (e) { process.stderr.write(e.message + '\n'); process.exitCode = 1 }
