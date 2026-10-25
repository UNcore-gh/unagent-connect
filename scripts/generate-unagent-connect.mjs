#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {packageMain} from './package.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),common=await readFile(path.join(root,'templates/shared.md'),'utf8')
for(const [template,target] of [['external.md','SKILL.md'],['native.md','reference/native-skill.md']]){
 const content=(await readFile(path.join(root,'templates',template),'utf8')).replace('{{SHARED}}',common).trimEnd()+'\n'
 const file=path.join(root,target)
 if(process.argv.includes('--check')){if(await readFile(file,'utf8').catch(()=>'')!==content)throw new Error('Generated skill has drifted: '+target)}else await writeFile(file,content)
}
if(process.argv.includes('--out'))await packageMain(process.argv.slice(2))
