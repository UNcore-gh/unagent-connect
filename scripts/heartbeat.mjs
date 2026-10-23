// Standalone Node.js tool; never bundled into the Obsidian plugin.
import process from 'node:process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

/** One manually claimed task, bounded lifetime, no retry on failure. */
export async function runHeartbeat({ beat, signal, durationMs = 900_000, intervalMs = 20_000, now = Date.now, wait = sleep }) {
  if (!Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > 3_600_000) throw new Error('duration-ms must be 1000..3600000')
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 20_000) throw new Error('interval-ms must be 1000..20000')
  const end = now() + durationMs
  let count = 0
  while (!signal.aborted && now() < end) {
    await beat(signal)
    count++
    if (signal.aborted || now() >= end) break
    try { await wait(Math.min(intervalMs, end - now()), undefined, { signal }) }
    catch (error) { if (!signal.aborted) throw error }
  }
  return { stopped: true, reason: signal.aborted ? 'signal' : 'duration', count }
}

/** Credentials stay on stdin. The child has a 10s deadline, with no shell. */
export function heartbeatCall(cliPath, { instance, client, params }, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'call', 'inbox.heartbeat', '--instance', instance,
      '--client', client, '--idem', `heartbeat-${randomUUID()}`, '--params-file', '-', '--timeout-ms', '8000'],
    { stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: 10_000 })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.resume() // Do not echo backend errors or execution credentials.
    child.stdin.on('error', () => {})
    child.once('error', () => reject(new Error('Heartbeat stopped or could not start')))
    child.once('close', code => {
      if (code !== 0) return reject(new Error('Heartbeat failed; stopped without retry. Check task lease before continuing.'))
      try {
        const result = JSON.parse(stdout)
        if (result.status !== 'completed') throw new Error('Not acknowledged')
        resolve()
      } catch { reject(new Error('Heartbeat not acknowledged; stopped without retry.')) }
    })
    child.stdin.end(JSON.stringify(params))
  })
}
