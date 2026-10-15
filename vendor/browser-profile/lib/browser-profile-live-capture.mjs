import {createRequire} from 'node:module'
import {openAgentLiveReadScope} from './browser-profile-live-read.mjs'
const require=createRequire(import.meta.url),{exactAuthority}=require('./browser-profile-core/coordinator-client.js'),{NativeLiveBackupCapture}=require('./browser-profile-core/live-backup-capture.js'),{BackupSealWorker}=require('./browser-profile-core/backup-seal-client.js'),{validateSealRequest}=require('./browser-profile-core/live-backup-input.js')
const fail=code=>Object.assign(new Error(code),{code}),sync=callback=>{const value=callback();if(value?.then){void Promise.resolve(value).catch(()=>{});throw fail('profile_live_async_proof')}if(value===false)throw fail('profile_live_context_changed');return value}
/** Readonly best-effort capture. A logical timeout never releases the native
 * scope or seal worker. No active backup can become a stopped checkpoint. */
export class AgentLiveBackupCapture{
 #work=null
 #scope=null
 #closed=false
 #cleanupUnknown=false
 constructor({runtime,authority,assertCurrent,protection,readExtras,timeoutMs=5000,seal=new BackupSealWorker()}){
  if(!runtime||[assertCurrent,protection,readExtras].some(value=>typeof value!=='function')||[seal?.seal,seal?.whenDrained].some(value=>typeof value!=='function')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw fail('profile_live_configuration_invalid')
  Object.defineProperties(this,{runtime:{value:runtime},authority:{value:exactAuthority(authority)},assertCurrent:{value:assertCurrent},protection:{value:protection},readExtras:{value:readExtras},timeoutMs:{value:timeoutMs},seal:{value:seal}})
 }
 #check(){sync(this.assertCurrent);if(this.#closed||this.#cleanupUnknown)throw fail('profile_live_context_changed')}
 activity(){return Object.freeze({pendingPhysicalOperations:this.#work?1:0,cleanupUnknown:this.#cleanupUnknown})}
 capture(request){
  if(this.#work||this.#closed||this.#cleanupUnknown)return Promise.resolve(Object.freeze({state:'skipped',reason:this.#cleanupUnknown?'profile_live_cleanup_unknown':'profile_live_busy_or_closed'}))
  try{validateSealRequest(request);this.#check();request=structuredClone(request)}catch{return Promise.resolve(Object.freeze({state:'skipped',reason:'profile_live_input_invalid'}))}
  let capture,timer
  const work=Promise.resolve().then(async()=>{
   this.#check();const scope=await openAgentLiveReadScope({runtime:this.runtime,authority:this.authority,assertCurrent:()=>this.#check(),protection:this.protection,timeoutMs:this.timeoutMs});this.#scope=scope;this.#check()
   capture=new NativeLiveBackupCapture({authority:this.authority,openReadScope:()=>scope,readExtras:this.readExtras,protection:this.protection,assertCurrent:()=>this.#check(),timeoutMs:this.timeoutMs,sealDraft:async input=>{this.#check();await scope.verify();this.#check();const sealed=await this.seal.seal(input);this.#check();return sealed}})
   const result=await capture.capture(request);await capture.whenDrained();if(capture.physical!==null)throw fail('profile_live_cleanup_unknown');return result
  }).catch(error=>{if(error?.code==='profile_live_cleanup_unknown')this.#cleanupUnknown=true;return Object.freeze({state:'skipped',reason:typeof error?.code==='string'&&/^profile_live_[a-z_]+$/.test(error.code)?error.code:'profile_live_capture_failed'})}).finally(async()=>{
   request.contentKeyEpoch.key.fill(0);const scope=this.#scope,callbacks=[()=>scope?.release(),()=>scope?.whenDrained(),()=>capture?.whenDrained(),()=>this.seal.whenDrained()],results=await Promise.allSettled(callbacks.map(callback=>Promise.resolve().then(callback)))
   if(this.#cleanupUnknown||results.some(result=>result.status==='rejected')||scope&&(scope.activity().cleanupUnknown||scope.activity().pendingPhysicalOperations!==0)||capture?.physical||this.seal.physical){this.#cleanupUnknown=true;throw fail('profile_live_cleanup_unknown')}
   this.#scope=null;if(this.#work===work)this.#work=null
  });this.#work=work;void work.catch(()=>{})
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(Object.freeze({state:'skipped',reason:'profile_live_timeout'})),this.timeoutMs)})
  return Promise.race([work,timeout]).finally(()=>clearTimeout(timer))
 }
 async whenDrained(){if(this.#work)await this.#work;if(this.#cleanupUnknown)throw fail('profile_live_cleanup_unknown')}
 async dispose(){this.#closed=true;const results=await Promise.allSettled([()=>this.#scope?.release(),()=>this.whenDrained()].map(callback=>Promise.resolve().then(callback)));if(results.some(result=>result.status==='rejected')){this.#cleanupUnknown=true;throw fail('profile_live_cleanup_unknown')}}
}
