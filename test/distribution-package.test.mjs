import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { packageProject, sourceFiles, ROOT } from '../scripts/package.mjs'
import { Script } from 'node:vm'
import { UI_JS } from '../src/ui.mjs'

test('browser script parses independently and source whitelist excludes private state', async()=>{
  new Script(UI_JS)
  const files=await sourceFiles()
  assert.ok(files.includes('src/server.mjs')&&files.includes('src/core/hub.mjs')&&files.includes('src/adapters/index.mjs'))
  assert.ok(files.every(f=>!/(?:^|\/)(?:data\.json|\.env|logs?|credentials|test|UNagent-src)(?:\/|$)/.test(f)))
  assert.ok(!UI_JS.includes('innerHTML'))
})
test('independent package runs CLI/MCP/serve outside source tree, and installer rejects symlink destinations', {timeout:60000},async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'connect-package-'))
 let service
 t.after(async()=>{if(service&&!service.killed){service.kill('SIGTERM');await new Promise(resolve=>{if(service.exitCode!==null)resolve();else service.once('exit',resolve)})}await rm(temp,{recursive:true,force:true})})
 const built=await packageProject({out:path.join(temp,'output')})
 const sums=await readFile(path.join(built.directory,'SHA256SUMS'),'utf8')
 assert.match(sums,/node_modules\/@modelcontextprotocol\/sdk\//)
 assert.doesNotMatch(sums, /node_modules\/@anthropic-ai\/claude-agent-sdk\//)
 assert.doesNotMatch(sums,/(?:  |\/)(?:data\.json|\.env|logs?|credentials|UNagent-src)(?:\/|$)/m)
 assert.equal(await readFile(path.join(built.directory,'LICENSE'),'utf8'),await readFile(path.join(ROOT,'LICENSE'),'utf8'))
 const run=(...args)=>spawnSync(process.execPath,args,{cwd:built.directory,encoding:'utf8',env:{PATH:process.env.PATH}})
 const help=run('bin/connect.mjs','help');assert.equal(help.status,0,help.stderr)
 // Import from a relocated temp root: dependencies cannot resolve via the source project.
 const mcp=run('--input-type=module','--eval',"await import('./src/mcp.mjs'); console.log('mcp-ready')")
 assert.equal(mcp.status,0,mcp.stderr);assert.match(mcp.stdout,/mcp-ready/)
 const target=path.join(temp,'linked');await symlink(built.directory,target,'dir')
 const install=run('scripts/install.mjs','--target-dir',target,'--apply')
 assert.notEqual(install.status,0);assert.match(install.stderr,/Symlink refused/)
 const state=path.join(temp,'state')
 service=spawn(process.execPath,['bin/connect.mjs','serve','--port','0','--state-dir',state],{cwd:built.directory,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH}})
 let stderr='';service.stderr.on('data',x=>stderr+=x)
 const info=await new Promise((resolve,reject)=>{let stdout='';const timer=setTimeout(()=>reject(new Error('serve timeout '+stderr)),10000);service.stdout.on('data',x=>{stdout+=x;if(stdout.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(stdout.split('\n')[0]))}catch(e){reject(e)}}});service.once('error',reject);service.once('exit',code=>{clearTimeout(timer);reject(new Error('serve exited '+code+' '+stderr))})})
 assert.equal((await(await fetch(info.url+'/v1/health')).json()).version,'0.2.1')
 assert.equal((await(await fetch(info.url+'/')).text()).includes('本机协作管理'),true)
 const connection=JSON.parse(await readFile(info.connectionFile,'utf8'))
 const response=await fetch(info.url+'/v1/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.adminToken},body:JSON.stringify({method:'system.status',params:{}})})
 const status=(await response.json()).result
 assert.equal(status.participants.length,0)
 assert.equal(status.adapters.length,6)
 // No participants means no native application is admitted for execution.
 service.kill('SIGTERM');await new Promise(resolve=>service.once('exit',resolve));service=undefined
 await assert.rejects(readFile(info.connectionFile))
})
