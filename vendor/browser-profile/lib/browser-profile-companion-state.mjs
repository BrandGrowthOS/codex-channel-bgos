import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url),codec=require('./browser-profile-core/crypto.js'),{canonical}=require('./browser-profile-core/coordinator-client.js')
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/,MAX_BYTES=32768,MAX_ENDPOINTS=64
const fail=code=>Object.assign(new Error(code),{code}),same=(a,b)=>canonical(a).equals(canonical(b))
const exact=(value,fields)=>{if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw fail('profile_companion_state_refused');const d=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(d).length!==fields.length||fields.some(key=>!d[key]?.enumerable||!Object.hasOwn(d[key],'value')))throw fail('profile_companion_state_refused')}
function validate(value){
  exact(value,['version','scope','identity','keyRecord']);exact(value.scope,['profileId','actingUserId','assistantId','endpointId','keyFingerprint','pairingId','ownerUserId'])
  const scope=value.scope,record=value.keyRecord
  if(value.version!==1||!UUID.test(scope.profileId)||!UUID.test(scope.endpointId)||![scope.actingUserId,scope.ownerUserId].every(id=>typeof id==='string'&&ID.test(id))||!['assistantId','pairingId'].every(key=>Number.isSafeInteger(scope[key])&&scope[key]>0)||value.identity.endpointId!==scope.endpointId||codec.identityFingerprint(value.identity)!==scope.keyFingerprint)throw fail('profile_companion_state_refused')
  exact(record,['version','provider','recordId','binding','keys']);exact(record.binding,['profileId','actingUserId','assistantId','endpointId','keyFingerprint','grantVersion','keyEpoch','backgroundUse']);exact(record.keys,['version','identityFingerprint','ciphertext'])
  if(record.version!==1||record.provider!=='libsecret-v1'||!UUID.test(record.recordId)||['profileId','actingUserId','assistantId','endpointId','keyFingerprint'].some(key=>record.binding[key]!==scope[key])||!['grantVersion','keyEpoch'].every(key=>Number.isSafeInteger(record.binding[key])&&record.binding[key]>0)||record.binding.backgroundUse!==true||record.keys.version!==1||record.keys.identityFingerprint!==scope.keyFingerprint||typeof record.keys.ciphertext!=='string'||record.keys.ciphertext.length<1||record.keys.ciphertext.length>12000||!/^[A-Za-z0-9_-]+$/.test(record.keys.ciphertext))throw fail('profile_companion_state_refused')
  return structuredClone(value)
}
function check(callback){if(typeof callback!=='function')throw fail('profile_companion_context_changed');const value=callback();if(value?.then){void Promise.resolve(value).catch(()=>{});throw fail('profile_companion_context_changed')}if(value===false)throw fail('profile_companion_context_changed')}
/** Private encrypted endpoint catalog, not runtime or grant authority. */
export class AgentProfileCompanionState{
  constructor({directory}){if(typeof directory!=='string'||!path.isAbsolute(directory))throw fail('profile_companion_state_refused');this.directory=path.resolve(directory);this.busy=false}
  _private(stat,directory=false){if(stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile())||!directory&&stat.nlink!==1||process.platform!=='win32'&&((stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid()))throw fail('profile_companion_state_refused')}
  async _directory(create){let current=path.parse(this.directory).root;for(const part of this.directory.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);let stat;try{stat=await fs.lstat(current)}catch(error){if(error.code!=='ENOENT')throw error;if(!create)return false;await fs.mkdir(current,{mode:0o700});stat=await fs.lstat(current)}if(stat.isSymbolicLink()||!stat.isDirectory())throw fail('profile_companion_state_refused');if(current===this.directory)this._private(stat,true)}return true}
  async _read(file){const before=await fs.lstat(file);this._private(before);if(before.size<1||before.size>MAX_BYTES)throw fail('profile_companion_state_refused');let handle
    try{handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=await handle.stat();if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size)throw fail('profile_companion_state_refused');const bytes=Buffer.alloc(before.size+1);let used=0;while(used<bytes.length){const{bytesRead}=await handle.read(bytes,used,bytes.length-used,used);if(!bytesRead)break;used+=bytesRead}const after=await handle.stat(),named=await fs.lstat(file);if(used!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||named.ino!==before.ino||named.dev!==before.dev)throw fail('profile_companion_state_refused');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)),parsed=JSON.parse(text);if(!canonical(parsed).equals(Buffer.from(text)))throw fail('profile_companion_state_refused');return validate(parsed)}finally{await handle?.close()}}
  async loadAll(assertCurrent){check(assertCurrent);if(!await this._directory(false)){check(assertCurrent);return[]};const names=await fs.readdir(this.directory);check(assertCurrent);if(names.some(name=>name==='catalog.lock'||name.endsWith('.tmp')))throw fail('profile_companion_state_recovery_required');const files=names.filter(name=>name.endsWith('.json'));if(files.length>MAX_ENDPOINTS||files.some(name=>!UUID.test(name.slice(0,-5))))throw fail('profile_companion_state_refused');const rows=[];for(const name of files.sort()){const row=await this._read(path.join(this.directory,name));check(assertCurrent);if(row.scope.endpointId!==name.slice(0,-5))throw fail('profile_companion_state_refused');rows.push(row)}return rows}
  async _syncDirectory(){
    // The product companion requires Linux Secret Service. Windows unit tests
    // cannot establish directory metadata durability or native key support.
    if(process.platform==='win32')return false
    const handle=await fs.open(this.directory,constants.O_RDONLY|(constants.O_DIRECTORY||0));try{await handle.sync();return true}finally{await handle.close()}
  }
  async saveNew(raw,assertCurrent){const value=validate(raw),bytes=canonical(value);if(bytes.length>MAX_BYTES||this.busy)throw fail('profile_companion_state_refused');this.busy=true;let lock,temporary,handle,renamed=false
    try{check(assertCurrent);await this._directory(true);lock=await fs.open(path.join(this.directory,'catalog.lock'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await this._syncDirectory();const names=await fs.readdir(this.directory),file=path.join(this.directory,value.scope.endpointId+'.json');check(assertCurrent)
      try{const prior=await this._read(file);if(!same(prior,value))throw fail('profile_companion_state_refused');check(assertCurrent);return prior}catch(error){if(error.code!=='ENOENT')throw error}
      if(names.filter(name=>name.endsWith('.json')).length>=MAX_ENDPOINTS)throw fail('profile_companion_state_full')
      temporary=path.join(this.directory,randomUUID()+'.tmp');handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;check(assertCurrent);await fs.rename(temporary,file);renamed=true;await this._syncDirectory();const readback=await this._read(file);check(assertCurrent);if(!same(readback,value))throw fail('profile_companion_state_refused');return readback
    }catch(error){if(renamed)throw fail('profile_companion_state_recovery_required');if(error.code==='EEXIST')throw fail('profile_companion_state_recovery_required');throw error}
    finally{try{await handle?.close();if(temporary&&!renamed)await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error});if(lock){await lock.close();await fs.unlink(path.join(this.directory,'catalog.lock'));await this._syncDirectory()}}finally{this.busy=false}}
  }
}
