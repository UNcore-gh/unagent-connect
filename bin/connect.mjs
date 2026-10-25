#!/usr/bin/env node
import { main } from '../src/cli.mjs'
main().then(code => { if (code) process.exitCode = code }).catch(error => {
  process.stderr.write(JSON.stringify({ error: { code: error.code || 'CONNECT_ERROR', message: error.message } }) + '\n')
  process.exitCode = 1
})
