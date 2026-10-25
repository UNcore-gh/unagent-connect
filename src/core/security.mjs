import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

export class HubError extends Error { constructor(code, message, status = 400) { super(message); this.code=code; this.status=status; this.httpStatus=status } }
export const fail = (code, message, status) => { throw new HubError(code,message,status) }
export const assert = (test, code, message, status) => { if (!test) fail(code,message,status) }
export const token = () => randomBytes(32).toString('hex')
export const hash = value => createHash('sha256').update(value).digest('hex')
export const equalHash = (left,right) => typeof left==='string' && typeof right==='string' && left.length===right.length && timingSafeEqual(Buffer.from(left),Buffer.from(right))
export function text(value, name, max=100_000) { assert(typeof value==='string' && value.trim().length && value.length<=max,'INVALID_ARGUMENT',`${name} must be nonempty text, at most ${max} characters`); return value.trim() }
export function object(value={}) { assert(value && typeof value==='object' && !Array.isArray(value),'INVALID_ARGUMENT','Expected an object'); return value }
export function number(value,fallback,min,max) { if(value===undefined)return fallback; assert(Number.isSafeInteger(value)&&value>=min&&value<=max,'INVALID_ARGUMENT',`Expected integer ${min}..${max}`); return value }
export function keys(input,allowed) { object(input); for(const key of Object.keys(input))assert(allowed.includes(key),'INVALID_ARGUMENT',`Unsupported field: ${key}`) }
export function canonicalDirectory(value) { const input=text(value,'workspace',4096); assert(path.isAbsolute(input),'INVALID_ARGUMENT','Workspace must be absolute'); let real; try { real=fs.realpathSync(input) } catch { fail('INVALID_ARGUMENT','Workspace does not exist') } assert(fs.statSync(real).isDirectory(),'INVALID_ARGUMENT','Workspace must be a directory'); return real }
export function privateFile(file,contents) { fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); const fd=fs.openSync(file,'wx',0o600); try{fs.writeFileSync(fd,contents)}finally{fs.closeSync(fd)} }
export function redact(value) { return String(value).replace(/\b(?:sk-[\w-]{16,}|Bearer\s+[\w.\-]{16,})/gi,'[redacted]') }
export function validateArtifacts(workspace,paths=[]) {
  assert(Array.isArray(paths)&&paths.length<=40,'INVALID_OUTPUT','Too many artifacts')
  return paths.map(input=>{ const file=text(input,'artifact',4096); const absolute=path.resolve(workspace,file); let real; try{real=fs.realpathSync(absolute)}catch{fail('INVALID_OUTPUT','Artifact does not exist')}
    assert(real.startsWith(workspace+path.sep)&&fs.statSync(real).isFile(),'INVALID_OUTPUT','Artifact must be a file inside this workspace');
    assert(path.basename(real)!=='data.json','INVALID_OUTPUT','Plugin configuration cannot be shared as an artifact');
    return {path:real,name:path.basename(real),bytes:fs.statSync(real).size}
  })
}
