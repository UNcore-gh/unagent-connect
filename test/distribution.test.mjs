import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const run = (...args) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
test('generated outputs match shared source', () => assert.equal(run('scripts/generate-unagent-connect.mjs', '--check').status, 0))
test('package installs only after apply, refuses modifications and rejects tampering', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'unagent-distribution-'))
  try {
    const out = path.join(temp, 'out')
    const built = run('scripts/generate-unagent-connect.mjs', '--out', out)
    assert.equal(built.status, 0, built.stderr)
    assert.equal(await readFile(path.join(out, 'unagent-connect/LICENSE'), 'utf8'), await readFile(path.join(root, 'LICENSE'), 'utf8'))
    assert.match(await readFile(path.join(out, 'unagent-connect/README.md'), 'utf8'), /仅分发通讯包/)
    const installer = path.join(out, 'unagent-connect/scripts/install.mjs')
    const target = path.join(temp, 'skills')
    let result = run(installer, '--target-dir', target)
    assert.equal(result.status, 0, result.stderr)
    await assert.rejects(readFile(path.join(target, 'unagent-connect/SKILL.md')))
    result = run(installer, '--target-dir', target, '--apply')
    assert.equal(result.status, 0, result.stderr)
    const installed = path.join(target, 'unagent-connect/SKILL.md')
    await writeFile(installed, 'my changes')
    result = run(installer, '--target-dir', target, '--apply')
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /modified/)
    assert.equal(await readFile(installed, 'utf8'), 'my changes')
    await writeFile(path.join(out, 'unagent-connect/SKILL.md'), 'tampered')
    result = run(installer, '--target-dir', path.join(temp, 'other'), '--apply')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Checksum mismatch/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
