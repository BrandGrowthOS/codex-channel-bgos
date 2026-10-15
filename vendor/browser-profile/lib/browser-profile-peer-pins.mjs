import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { sign,verify,randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { AgentProfileCompanionState } from './browser-profile-companion-state.mjs'
const require=createRequire(import.meta.url),codec=require('./browser-profile-core/crypto.js'),{canonical}=require('./browser-profile-core/coordinator-client.js')
const FIELDS=['version','kind','profileId','actingUserId','assistantId','agentEndpointId','agentKeyFingerprint','peerIdentity','peerKeyFingerprint']
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const fail=()=>Object.assign(new Error('profile_peer_pin_review_refused'),{code:'profile_peer_pin_review_refused'})
const exact=(value,fields)=>{if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw fail();const d=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(d).length!==fields.length||fields.some(key=>!d[key]?.enumerable||!Object.hasOwn(d[key],'value')))throw fail()}
const check=callback=>{if(typeof callback!=='function')throw fail();const value=callback();if(value?.then){void Promise.resolve(value).catch(()=>{});throw fail()}if(value===false)throw fail()}
export function peerReviewDocument(raw){exact(raw,FIELDS);if(raw.version!==1||raw.kind!=='agent-peer-pin-review'||!UUID.test(raw.profileId)||typeof raw.actingUserId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(raw.actingUserId)||!Number.isSafeInteger(raw.assistantId)||raw.assistantId<1||!UUID.test(raw.agentEndpointId)||typeof raw.agentKeyFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(raw.agentKeyFingerprint)||!UUID.test(raw.peerIdentity?.endpointId)||raw.peerIdentity.endpointId===raw.agentEndpointId||codec.identityFingerprint(raw.peerIdentity)!==raw.peerKeyFingerprint)throw fail();return structuredClone(raw)}
function documentOf(raw,scope){const document=peerReviewDocument(raw);if(document.profileId!==scope.profileId||document.actingUserId!==scope.actingUserId||document.assistantId!==scope.assistantId||document.agentEndpointId!==scope.endpointId||document.agentKeyFingerprint!==scope.keyFingerprint)throw fail();return document}
function verifyRecord(raw,scope,ownIdentity){exact(raw,['document','signature']);const document=documentOf(raw.document,scope);if(codec.identityFingerprint(ownIdentity)!==scope.keyFingerprint||ownIdentity.endpointId!==scope.endpointId||typeof raw.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(raw.signature)||Buffer.from(raw.signature,'base64url').toString('base64url')!==raw.signature||!verify(null,canonical(document),{key:Buffer.from(ownIdentity.signingPublicKey,'base64url'),format:'der',type:'spki'},Buffer.from(raw.signature,'base64url')))throw fail();return{document,signature:raw.signature}}

/** Explicit local operator review, separate from grant or runtime authority.
 * Review JSON is public setup material. No direct peer connection is opened. */
export class AgentProfilePeerPins{
  constructor({directory}){this.files=new AgentProfileCompanionState({directory});this.directory=this.files.directory}
  async _read(file){const before=await fs.lstat(file);this.files._private(before);if(before.size<1||before.size>8192)throw fail();let handle;try{handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=await handle.stat();if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size)throw fail();const bytes=Buffer.alloc(before.size+1);let used=0;while(used<bytes.length){const{bytesRead}=await handle.read(bytes,used,bytes.length-used,used);if(!bytesRead)break;used+=bytesRead}const after=await handle.stat(),named=await fs.lstat(file);if(used!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||named.ino!==before.ino||named.dev!==before.dev)throw fail();const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)),raw=JSON.parse(text);if(!canonical(raw).equals(Buffer.from(text)))throw fail();return raw}finally{await handle?.close()}}
  async list({scope,ownIdentity,assertCurrent}){check(assertCurrent);if(!await this.files._directory(false)){check(assertCurrent);return[]};const names=await fs.readdir(this.directory);if(names.some(name=>!/^peer-[a-f0-9-]{36}\.json$/.test(name))||names.length>4)throw fail();const result=[];for(const name of names.sort()){const row=verifyRecord(await this._read(path.join(this.directory,name)),scope,ownIdentity);check(assertCurrent);if(name!==`peer-${row.document.peerIdentity.endpointId}.json`)throw fail();result.push(row.document.peerIdentity)}return result}
  async review({scope,endpoint,document:raw,confirmation,assertCurrent}){
    check(assertCurrent);const document=documentOf(raw,scope);if(confirmation!==document.peerKeyFingerprint||codec.identityFingerprint(endpoint.identity)!==scope.keyFingerprint||endpoint.identity.endpointId!==scope.endpointId)throw fail()
    const record={document,signature:sign(null,canonical(document),endpoint.signingPrivateKey).toString('base64url')};verifyRecord(record,scope,endpoint.identity)
    await this.files._directory(true);check(assertCurrent);let lock,publicationFailed=false
    try{lock=await fs.open(path.join(this.directory,'review.lock'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await this.files._syncDirectory();const names=(await fs.readdir(this.directory)).filter(name=>name!=='review.lock'),file=path.join(this.directory,`peer-${document.peerIdentity.endpointId}.json`)
    if(names.some(name=>!/^peer-[a-f0-9-]{36}\.json$/.test(name)))throw fail()
    if(names.includes(path.basename(file))){const existing=verifyRecord(await this._read(file),scope,endpoint.identity);check(assertCurrent);if(!canonical(existing).equals(canonical(record)))throw fail();return{reviewed:true,peerKeyFingerprint:document.peerKeyFingerprint}}
    if(names.length>=4)throw fail();const bytes=canonical(record);if(bytes.length>8192)throw fail();const temporary=path.join(this.directory,`${randomUUID()}.tmp`);let handle,linked=false
    try{handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;check(assertCurrent);await fs.link(temporary,file);linked=true;await fs.unlink(temporary);await this.files._syncDirectory();const saved=verifyRecord(await this._read(file),scope,endpoint.identity);check(assertCurrent);if(!canonical(saved).equals(bytes))throw fail();return{reviewed:true,peerKeyFingerprint:document.peerKeyFingerprint}}
    catch{if(linked)publicationFailed=true;throw fail()}finally{await handle?.close();if(!linked)await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
    }finally{if(lock){await lock.close();if(!publicationFailed){await fs.unlink(path.join(this.directory,'review.lock'));await this.files._syncDirectory()}}}
  }
}
