import path from 'node:path'
import {createHash,createPublicKey,KeyObject} from 'node:crypto'
import {createRequire} from 'node:module'
import {AgentLiveBackupCapture} from './browser-profile-live-capture.mjs'
const require=createRequire(import.meta.url),codec=require('./browser-profile-core/crypto.js'),{sameAuthority,canonical}=require('./browser-profile-core/coordinator-client.js'),{scopeOf,authorityOf,pinMap}=require('./browser-profile-core/active-backup-wire.js'),{PairedActiveBackupClient}=require('./browser-profile-core/active-backup-client.js'),{ActiveBackupScheduler}=require('./browser-profile-core/active-backup-scheduler.js'),{EncryptedBackupJournal}=require('./browser-profile-core/backup-journal.js')
const sources=new WeakMap(),leases=new Set(),fail=code=>Object.assign(new Error(code),{code}),same=(a,b)=>canonical(a).equals(canonical(b)),digest=value=>createHash('sha256').update(value).digest('hex')
const sync=callback=>{const value=callback();if(value?.then){void Promise.resolve(value).catch(()=>{});throw fail('profile_backup_context_changed')}if(value===false)throw fail('profile_backup_context_changed');return value}
const active=(profile,authority)=>profile?.writerState==='active'&&profile.id===authority.profileId&&profile.actingUserId===authority.actingUserId&&profile.assistantId===authority.assistantId&&['endpointId','bootId','runtimeId','sessionId','writerEpoch','revision','contentKeyEpoch'].every(key=>profile[key]===authority[key])

/** Main-only advisory backup composition. Fresh coordinator metadata does not
 * review a peer. The whole admitted set must match local signed identity pins.
 * There is no restore, writer activation or stopped-checkpoint API here. */
export class AgentActiveBackup {
 #closed=false
 #paused=true
 #pausedDrained=true
 #cleanupUnknown=false
 #lease={}
 #draining=null
 #hintTimer=null
 #hintGeneration=0
 #nextDue=null
 #confirmedHash=null
 #automaticAfter=0
 #automaticAttempt=null
 constructor({origin,directory,endpoint,authority:rawAuthority,ownerUserId,pairingId,runtime,assertCurrent,authorizePairing,peerIdentities,readExtras,currentContentKey,fetchImpl,debounceMs=60000,timeoutMs=15000,captureTimeoutMs=5000,onStatus=()=>{},journal,capture,client}){
  const authority=authorityOf(rawAuthority),scope=scopeOf({profileId:authority.profileId,actingUserId:authority.actingUserId,assistantId:authority.assistantId}),identity=pinMap([endpoint?.identity]).get(authority.endpointId)?.identity
  if(!runtime||sources.has(runtime)||leases.size>=4||!path.isAbsolute(directory)||[assertCurrent,authorizePairing,peerIdentities,readExtras,currentContentKey,onStatus].some(value=>typeof value!=='function')||typeof ownerUserId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(ownerUserId)||!Number.isSafeInteger(pairingId)||pairingId<1||!identity||codec.identityFingerprint(identity)!==authority.keyFingerprint||[endpoint.signingPrivateKey,endpoint.encryptionPrivateKey].some(key=>!(key instanceof KeyObject)||key.type!=='private')||createPublicKey(endpoint.signingPrivateKey).export({type:'spki',format:'der'}).toString('base64url')!==identity.signingPublicKey||createPublicKey(endpoint.encryptionPrivateKey).export({type:'spki',format:'der'}).toString('base64url')!==identity.encryptionPublicKey)throw fail('profile_backup_configuration_invalid')
  const originalContext=runtime.context,originalEndpoint=endpoint,originalKey=endpoint.signingPrivateKey,originalEncryptionKey=endpoint.encryptionPrivateKey
  const current=()=>{sync(assertCurrent);if(this.#closed||this.#cleanupUnknown||this.#paused||runtime.context!==originalContext||runtime.state!=='active'||runtime.network!=='active'||runtime.operation!==null||!sameAuthority(runtime.authority,authority)||endpoint!==originalEndpoint||endpoint.identity!==originalEndpoint.identity||endpoint.signingPrivateKey!==originalKey||endpoint.encryptionPrivateKey!==originalEncryptionKey||!same(endpoint.identity,identity))throw fail('profile_backup_context_changed');return true}
  const protection=()=>{current();const extras=sync(readExtras);return Object.freeze({blocked:false,version:digest(canonical(extras))})}
  this.authority=authority;this.scope=scope;this.runtime=runtime;this.checkCurrent=current;this.endpoint=Object.freeze({identity,signingPrivateKey:originalKey,encryptionPrivateKey:originalEncryptionKey});this.peerIdentities=peerIdentities;this.currentContentKey=currentContentKey;this.ownerUserId=ownerUserId;this.pairingId=pairingId
  this.journal=journal||new EncryptedBackupJournal({directory});this.capture=capture||new AgentLiveBackupCapture({runtime,authority,assertCurrent:current,protection,readExtras,timeoutMs:captureTimeoutMs});this.client=client||new PairedActiveBackupClient({endpoint:origin,authorizePairing,journal:this.journal,...(fetchImpl?{fetchImpl}:{})})
  if(['endpointContext','endpointHead','upload','cancelPending','whenDrained'].some(name=>typeof this.client?.[name]!=='function')||['capture','whenDrained','dispose','activity'].some(name=>typeof this.capture?.[name]!=='function')||!sameAuthority(this.capture.authority,authority))throw fail('profile_backup_configuration_invalid')
  this.scheduler=new ActiveBackupScheduler({scope,currentContext:()=>this.#context(),client:this.client,journal:this.journal,debounceMs,timeoutMs,onStatus:value=>{if(value.state==='confirmed'&&value.lastConfirmed?.bundleHash&&value.lastConfirmed.bundleHash!==this.#confirmedHash){this.#confirmedHash=value.lastConfirmed.bundleHash;this.#nextDue=Date.now()+60000;if(!this.#paused&&!this.#closed){this.#clearHints();this.#armHint()}}onStatus(value)}})
  sources.set(runtime,this.#lease);leases.add(this.#lease)
 }
 async #context(){
  this.checkCurrent();if(this.#automaticAttempt?.work===this.scheduler.physical)this.#automaticAttempt.entered=true;const local=await this.peerIdentities(this.checkCurrent);this.checkCurrent();const reviewed=pinMap(local),pins=[this.endpoint.identity,...[...reviewed.values()].map(row=>row.identity)];pinMap(pins)
  const context=await this.client.endpointContext({scope:this.scope,authority:this.authority,endpoint:this.endpoint,pins,assertCurrent:this.checkCurrent});this.checkCurrent()
  if(!active(context?.profile,this.authority)||!context.request||!sameAuthority(context.request.sourceAuthority,this.authority)||!Number.isSafeInteger(context.request.expiresAt)||context.request.expiresAt<=Date.now()||!Array.isArray(context.recipients)||context.recipients.length<1||context.recipients.length>4)throw fail('profile_backup_recipient_set_changed')
  const recipients=[],seen=new Set();let own=false
  for(const row of context.recipients){
   const key=pinMap([row.identity]).get(row.identity.endpointId),source=row.identity.endpointId===this.authority.endpointId;if(seen.has(row.identity.endpointId)||key.fingerprint!==row.keyFingerprint||!Number.isSafeInteger(row.grantVersion)||row.grantVersion<1)throw fail('profile_backup_recipient_set_changed');seen.add(row.identity.endpointId)
   if(source){if(own||!same(row.identity,this.endpoint.identity)||row.kind!=='agent'||row.ownerUserId!==this.ownerUserId||row.pairingId!==this.pairingId||row.grantVersion!==this.authority.grantVersion)throw fail('profile_backup_source_pairing_changed');own=true}
   else{const pin=reviewed.get(row.identity.endpointId);if(!pin||!same(pin.identity,row.identity)||pin.fingerprint!==row.keyFingerprint||row.kind!=='desktop'||row.ownerUserId!==this.scope.actingUserId||row.pairingId!==null)throw fail('profile_backup_peer_review_required')}
   recipients.push({identity:key.identity,keyFingerprint:row.keyFingerprint,grantVersion:row.grantVersion})
  }
  if(!own)throw fail('profile_backup_source_pairing_changed')
  // The retained key is not read until every fresh recipient has passed the
  // independent local review and original source-party checks above.
  const key=sync(this.currentContentKey);if(!key||key.epoch!==this.authority.contentKeyEpoch||!(key.key instanceof Uint8Array)||key.key.byteLength!==32||!(key.key.buffer instanceof ArrayBuffer))throw fail('profile_backup_content_key_changed')
  const bytes=key.key,hash=digest(bytes),check=()=>{this.checkCurrent();const current=sync(this.currentContentKey);if(context.request.expiresAt<=Date.now()||current!==key||current.key!==bytes||current.epoch!==this.authority.contentKeyEpoch||digest(bytes)!==hash)throw fail('profile_backup_context_changed')};check()
  return{authority:this.authority,assertCurrent:check,capture:this.capture,source:this.endpoint,recipients,metadataPins:pins,contentKeyEpoch:key}
 }
 status(){const value=this.scheduler.status();return Object.freeze({...value,paused:this.#paused,cleanupUnknown:this.#cleanupUnknown})}
 activity(){const capture=this.capture.activity();return Object.freeze({pendingPhysicalOperations:(this.scheduler.physical?1:0)+(this.#draining?1:0)+capture.pendingPhysicalOperations,cleanupUnknown:this.#cleanupUnknown||capture.cleanupUnknown})}
 #clearHints(){this.#hintGeneration++;clearTimeout(this.#hintTimer);this.#hintTimer=null}
 #releaseUnstartedAttempt(attempt){if(attempt&&attempt===this.#automaticAttempt&&attempt.owned&&attempt.work&&!attempt.entered&&this.#paused&&this.#pausedDrained&&!this.#cleanupUnknown&&this.scheduler.physical===null&&this.#automaticAfter===attempt.deadline){this.#automaticAfter=attempt.previous;this.#automaticAttempt=null}}
 #dueHint(){const now=Date.now();if(this.#nextDue!==null&&now>=this.#nextDue&&now>=this.#automaticAfter){const previousWork=this.scheduler.physical,attempt={previous:this.#automaticAfter,deadline:now+60000,entered:false,owned:false,work:previousWork};this.#automaticAttempt=attempt;this.#automaticAfter=attempt.deadline;const pending=this.scheduler.captureNow();attempt.work=this.scheduler.physical;attempt.owned=previousWork===null&&attempt.work!==null;void pending.finally(()=>{if(this.#automaticAttempt===attempt&&!(this.#paused&&attempt.owned&&!attempt.entered))this.#automaticAttempt=null}).catch(()=>{})}else this.scheduler.notify()}
 #armHint(){if(this.#paused||this.#closed||this.#cleanupUnknown||this.#hintTimer!==null)return;const generation=this.#hintGeneration,now=Date.now(),eligible=Math.max(this.#nextDue??now+60000,this.#automaticAfter),timer=setTimeout(()=>{if(generation!==this.#hintGeneration||this.#hintTimer!==timer||this.#paused||this.#closed)return;this.#hintTimer=null;try{this.checkCurrent();this.#dueHint();if(generation===this.#hintGeneration)this.#armHint()}catch{void this.pause().catch(()=>{})}},Math.max(1,Math.min(60000,eligible-now)));this.#hintTimer=timer;timer.unref?.()}
 start(){if(this.#closed||this.#cleanupUnknown||!this.#pausedDrained)throw fail('profile_backup_cleanup_unknown');const wasPaused=this.#paused;this.#paused=false;try{this.checkCurrent()}catch(error){this.#paused=true;throw error}if(wasPaused){this.scheduler.start();this.#nextDue??=Date.now()+60000;this.#dueHint();this.#clearHints();this.#armHint()}return this.status()}
 notify(){if(!this.#paused&&!this.#closed&&!this.#cleanupUnknown){try{this.checkCurrent();this.scheduler.notify()}catch{}}}
 captureNow(){this.checkCurrent();return this.scheduler.captureNow()}
 reconcile(){this.checkCurrent();return this.scheduler.reconcile()}
 #stop(){try{this.scheduler.stop()}catch{this.#cleanupUnknown=true}}
 pause(){const attempt=this.#automaticAttempt;this.#clearHints();this.#paused=true;this.#pausedDrained=false;this.#stop();return this.whenDrained().then(()=>{this.#pausedDrained=true;this.#releaseUnstartedAttempt(attempt);return Object.freeze({drained:true})})}
 whenDrained(){
  if(this.#draining)return this.#draining
  const task=Promise.resolve().then(async()=>{const results=await Promise.allSettled([()=>this.scheduler.whenDrained(),()=>this.capture.whenDrained(),()=>this.client.whenDrained(),()=>this.journal.whenDrained()].map(callback=>Promise.resolve().then(callback)));const activity=this.capture.activity();if(this.#cleanupUnknown||results.some(row=>row.status==='rejected')||this.scheduler.physical||activity.cleanupUnknown||activity.pendingPhysicalOperations!==0){this.#cleanupUnknown=true;throw fail('profile_backup_cleanup_unknown')}}).finally(()=>{if(this.#draining===task)this.#draining=null});this.#draining=task;void task.catch(()=>{});return task
 }
 dispose(){this.#clearHints();this.#closed=true;this.#paused=true;this.#pausedDrained=false;this.#stop();return Promise.resolve().then(async()=>{const results=await Promise.allSettled([()=>this.capture.dispose(),()=>this.whenDrained()].map(callback=>Promise.resolve().then(callback)));if(this.#cleanupUnknown||results.some(row=>row.status==='rejected')){this.#cleanupUnknown=true;throw fail('profile_backup_cleanup_unknown')}if(sources.get(this.runtime)===this.#lease)sources.delete(this.runtime);leases.delete(this.#lease)})}
}
