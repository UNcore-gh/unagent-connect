import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

test('CLI registers with optional purpose in request body and supports omission', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'unagent-purpose-'))
  const home = path.join(temp, '.unagent/bridge')
  const received = []
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/admin/status') return res.end('{}')
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    received.push(body)
    res.end(JSON.stringify({clientId: 'client',clientName: body.name,clientToken:'a'.repeat(64),instanceId:'instance',purpose:body.purpose}))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await mkdir(home, {recursive:true})
    await writeFile(path.join(home, 'host-admin.token'), 'a'.repeat(64))
    await writeFile(path.join(home, 'bridge-config.json'), JSON.stringify({address:`http://127.0.0.1:${server.address().port}`}))
    const run = args => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('scripts/unagent-connect.mjs'), 'client-register', ...args], {
        env:{...process.env,NODE_ENV:'test',UNAGENT_BRIDGE_TEST_HOME:home},stdio:['pipe','pipe','pipe'],
      })
      let err = ''; child.stderr.on('data', x => {err+=x}); child.stdout.resume()
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(err)))
      child.stdin.end('pair-code')
    })
    await run(['--name','with-purpose','--purpose','代码检查'])
    await run(['--name','without-purpose'])
    assert.equal(received[0].purpose, '代码检查')
    assert.equal(received[0].name, 'with-purpose')
    assert.equal(received[1].name, 'without-purpose')
    assert.equal(Object.hasOwn(received[1], 'purpose'), false)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(temp, {recursive:true,force:true})
  }
})
