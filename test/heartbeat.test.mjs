import test from 'node:test'
import assert from 'node:assert/strict'
import { runHeartbeat, heartbeatCall } from '../scripts/heartbeat.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('heartbeat renews immediately, bounded duration and no retry after failure', async () => {
  let clock = 0
  let beats = 0
  const signal = new AbortController().signal
  const result = await runHeartbeat({ beat: () => { beats++ }, signal, durationMs: 3000, intervalMs: 1000,
    now: () => clock, wait: ms => { clock += ms } })
  assert.equal(beats, 3)
  assert.equal(result.reason, 'duration')
  beats = 0
  await assert.rejects(runHeartbeat({ beat: () => { beats++; throw new Error('lease lost') }, signal }), /lease lost/)
  assert.equal(beats, 1)
})

test('manual stop prevents further renewals and invalid lifetime is rejected', async () => {
  const controller = new AbortController()
  let beats = 0
  const result = await runHeartbeat({ beat: () => { beats++; controller.abort() }, signal: controller.signal })
  assert.equal(beats, 1)
  assert.equal(result.reason, 'signal')
  await assert.rejects(runHeartbeat({ beat: () => {}, signal: controller.signal, durationMs: Infinity }), /duration-ms/)
})

test('helper sends credentials only on stdin and accepts acknowledged transport only', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'unagent-heartbeat-'))
  try {
    const cli = path.join(temp, 'fake.mjs')
    await writeFile(cli, `let input=''; for await (const x of process.stdin) input+=x;\nif(process.argv.join(' ').includes('private-token') || JSON.parse(input).executionToken !== 'private-token') process.exit(4);\nconsole.log(JSON.stringify({status:'completed'}));`)
    await heartbeatCall(cli, { instance: 'instance', client: 'client', params: {taskId:'task',executionToken:'private-token'} }, new AbortController().signal)
    await writeFile(cli, `console.log(JSON.stringify({status:'failed'}));`)
    await assert.rejects(heartbeatCall(cli, { instance:'instance',client:'client',params:{} }, new AbortController().signal), /not acknowledged/)
  } finally { await rm(temp, {recursive:true,force:true}) }
})
