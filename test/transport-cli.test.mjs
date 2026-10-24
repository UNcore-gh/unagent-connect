import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Hub } from '../src/core/hub.mjs'
import { createHubServer } from '../src/server.mjs'
import { localURL, readToken } from '../src/client.mjs'

function run(args,input='') {return new Promise((resolve,reject)=>{const p=spawn(process.execPath,['bin/connect.mjs',...args],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH}});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.once('error',reject);p.once('close',code=>resolve({code,stdout,stderr}));p.stdin.end(input)})}
test('CLI stdin/file RPC has no shell interpretation; status and legacy routing remain operational',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'connect-cli-'));const hub=new Hub({stateDir,adapters:[]}),server=createHubServer({hub,stateDir,port:0});await server.listen();t.after(async()=>{await server.close();await hub.close();await rm(stateDir,{recursive:true,force:true})})
 const a=await hub.call('participants.create',{name:'cli',provider:'manual',workspace:stateDir},{admin:true});const tokenFile=path.join(stateDir,'a.token');await writeFile(tokenFile,a.token,{mode:0o600})
 let result=await run(['rpc','participants.list','--token-file',tokenFile,'--url',server.origin],'{}');assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout)[0].id,a.participant.id)
 const text='literal $(touch should-not-exist) `echo bad` ; <script>用户正文</script>\n下一行'
 const paramsFile=path.join(stateDir,'params.json');await writeFile(paramsFile,JSON.stringify({recipientId:a.participant.id,content:text,idempotencyKey:'cli-message'}))
 result=await run(['rpc','messages.send','--params-file',paramsFile,'--token-file',tokenFile,'--url',server.origin]);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).message.content,text)
 result=await run(['status','--url',server.origin]);assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).version,'0.2.0')
 result=await run(['legacy','--help']);assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/pair|配对|client|UNagent/)
 result=await run(['rpc','participants.list','--url','http://example.com'],'{}');assert.notEqual(result.code,0)
 for(const url of ['http://localhost:18492','http://127.0.0.1:18492/?token=x','http://u:p@127.0.0.1:18492','https://127.0.0.1:18492','http://127.0.0.1:18492/else'])assert.throws(()=>localURL(url))
 const unsafe=path.join(stateDir,'unsafe');await writeFile(unsafe,a.token,{mode:0o644});await assert.rejects(readToken(unsafe),/600/)
})
