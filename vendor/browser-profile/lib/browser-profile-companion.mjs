import path from 'node:path'
import { randomUUID,createHash,verify } from 'node:crypto'
import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { AgentProfileCoordinatorClient } from './browser-profile-companion-client.mjs'
import { AgentProfileCompanionState } from './browser-profile-companion-state.mjs'
import { AgentProfilePeerPins } from './browser-profile-peer-pins.mjs'
import { BrowserProfileRuntime,restoreProfileEnrollment } from './browser-profile-runtime.mjs'
import { BrowserProfileSyncKeyStore } from './browser-profile-sync-key-store.mjs'
import { BrowserProfilePortableExtrasStore } from './browser-profile-portable-extras.mjs'
import { createChromiumRtcActivity } from './browser-profile-rtc-activity.mjs'
import { PairedProfileCoordinatorClient,createPairedProfileRuntimeEndpoint } from './browser-profile-pairing-client.mjs'
import { AgentRuntimePermissionClient } from './browser-profile-permission-client.mjs'
import { AgentRuntimePermissionRunner } from './browser-profile-permission-runner.mjs'
const require=createRequire(import.meta.url),codec=require('./browser-profile-core/crypto.js'),shared=require('./browser-profile-core/coordinator-client.js')
const {EncryptedCheckpointStore}=require('./browser-profile-core/checkpoint-store.js'),{ProfileRuntimeStatusClient}=require('./browser-profile-core/runtime-status-client.js')
const {createAgentStoppedHeadStageAuthorization,verifyAgentStoppedHeadJournalRecord}=require('./browser-profile-core/stopped-head-stage.js')
const policy=require('./browser-host-core/policy.js'),settings=require('./browser-host-core/settings.js')
const same=(a,b)=>shared.canonical(a).equals(shared.canonical(b)),fail=code=>Object.assign(new Error(code),{code})
const pick=(value,fields)=>Object.fromEntries(fields.map(key=>[key,value[key]])),destination=value=>pick(value,['endpointId','bootId','runtimeId','sessionId','grantVersion','keyFingerprint'])
const source=value=>pick(value,['endpointId','bootId','runtimeId','sessionId','writerEpoch']),head=profile=>({manifestHash:profile.headManifestHash,revision:profile.revision,keyEpoch:profile.contentKeyEpoch})
const toolError=(code,message)=>({isError:true,content:[{type:'text',text:`${code}: ${message}`}]})
const permissionTools=new Set(['browser_navigate','browser_click','browser_handle_dialog','browser_select_option','browser_file_upload','browser_pdf_save'])
const genericError=error=>typeof error?.code==='string'&&/^profile_[a-z0-9_]{1,90}$/.test(error.code)?error.code:'profile_companion_unavailable'

/** Main process only. Every network operation goes to the configured HOAI
 * origin. Public discovery is advisory; it never restores an active old boot. */
export class AgentBrowserProfileCompanion{
  #permissionCleanupUnknown=new WeakSet()
  #executions=new AsyncLocalStorage()
  #preparations=new WeakMap()
  constructor({connection,agentRoot,deviceLabel,environment=process.env,loadBrowser,createEngine,createRelay,assertNoLegacyActive=()=>true,log=/** @type {(line:string)=>void} */(()=>{}),client,keyStore,stateStore,createRuntime=options=>BrowserProfileRuntime.create(options),preloadExtras=options=>BrowserProfilePortableExtrasStore.preload(options),statusClient,permissionClient=/** @type {any} */(null),permissionRunner=/** @type {any} */(null)}){
    if(!connection||typeof loadBrowser!=='function'||typeof createEngine!=='function'||typeof createRelay!=='function'||!path.isAbsolute(agentRoot))throw fail('profile_companion_configuration_invalid')
    Object.assign(this,{connection,deviceLabel,environment,loadBrowser,createEngine,createRelay,assertNoLegacyActive,log,createRuntime,preloadExtras});this.token=connection.pairing.token;this.bootId=connection.bootId
    const pairingSnapshot={backendUrl:connection.pairing.backendUrl,pairingId:connection.pairing.pairingId,ownerUserId:connection.pairing.ownerUserId,assistantIds:JSON.stringify(connection.pairing.assistantIds)}
    this.directory=path.join(agentRoot,'.browser-profile-sync',createHash('sha256').update(new URL(connection.pairing.backendUrl).origin).digest('hex'));this.stopped=false;this.loaded=false;this.pending=null;this.records=new Map();this.candidates=new Map();this.cursor=0;this.lastState=new Map()
    this.check=()=>{if(this.stopped||connection._stopped||connection.bootId!==this.bootId||connection.pairing.token!==this.token||connection.pairing.backendUrl!==pairingSnapshot.backendUrl||connection.pairing.pairingId!==pairingSnapshot.pairingId||connection.pairing.ownerUserId!==pairingSnapshot.ownerUserId||JSON.stringify(connection.pairing.assistantIds)!==pairingSnapshot.assistantIds)throw fail('profile_companion_context_changed')}
    const authorizePairing=async context=>{this.check();const local=[...this.records.values()].find(record=>record.scope.actingUserId===context.actingUserId&&record.scope.assistantId===context.assistantId)?.scope;return{token:this.token,pairingId:context.pairingId??local?.pairingId,ownerUserId:context.ownerUserId??local?.ownerUserId,assistantId:context.assistantId,assertCurrent:this.check}}
    this.client=client||new AgentProfileCoordinatorClient({endpoint:connection.pairing.backendUrl,authorizePairing})
    this.keyStore=keyStore||new BrowserProfileSyncKeyStore({endpointCrypto:codec,environment})
    this.stateStore=stateStore||new AgentProfileCompanionState({directory:path.join(this.directory,'endpoints')})
    this.statusClient=statusClient;this.statusClientFactory=()=>new ProfileRuntimeStatusClient({origin:connection.pairing.backendUrl})
    this.rpcClient=new PairedProfileCoordinatorClient({endpoint:connection.pairing.backendUrl,authorizePairing})
    this.permissionClient=permissionClient||new AgentRuntimePermissionClient({origin:connection.pairing.backendUrl,authorizePairing})
    this.permissionRunner=permissionRunner||new AgentRuntimePermissionRunner({client:this.permissionClient})
  }
  _status(record,state){const key=record?.scope?.endpointId||'setup';if(this.lastState.get(key)===state)return;this.lastState.set(key,state);this.log(`managed browser ${record?.scope?.assistantId||''}: ${state}`)}
  hasNamespace(input){return typeof input?.principal==='string'&&[...this.records.values(),...this.candidates.values()].some(record=>record.scope.assistantId===input.assistantId&&`user-${record.scope.actingUserId}`===input.principal)}
  _cached(record){this.check();if(record.revoked||this.records.get(record.scope.endpointId)!==record)throw fail('profile_companion_context_changed');return true}
  _admit(record){this._cached(record);if(this.closing||record.admission!=='active'||record.uncertain||this.#permissionCleanupUnknown.has(record))throw fail('profile_companion_authority_unknown');record.runtime.assertCurrent();return true}
  async _drainCommands(record){await Promise.allSettled([...record.engineTasks]);if(record.engineTasks.size||this.#permissionCleanupUnknown.has(record))throw fail('profile_companion_command_drain_unconfirmed')}
  _binding(record,entry){return{profileId:record.scope.profileId,actingUserId:record.scope.actingUserId,assistantId:record.scope.assistantId,endpointId:record.scope.endpointId,keyFingerprint:record.scope.keyFingerprint,grantVersion:entry.grant.generation,keyEpoch:entry.profile.contentKeyEpoch,backgroundUse:true}}
  async _discover(record){this._cached(record);const result=await this.client.discover(record.scope,record.endpoint);this._cached(record);const entry=result.profiles[0];if(!entry)throw fail('profile_companion_background_grant_required');record.entry=entry;return entry}
  async _load(){if(this.loaded)return;const rows=await this.stateStore.loadAll(this.check);this.check();for(const row of rows){if(!this.connection.pairing.assistantIds.includes(row.scope.assistantId)||this.connection.pairing.pairingId&&row.scope.pairingId!==this.connection.pairing.pairingId)continue;const record={...row,endpoint:null,runtime:null,admission:'blocked',revoked:false,uncertain:false,attempted:new Set(),engineTasks:new Set(),state:'saved'};this.records.set(row.scope.endpointId,record)}this.loaded=true}
  async _endpoint(record){if(record.endpoint)return;const endpoint=await restoreProfileEnrollment({keyStore:this.keyStore,record:record.keyRecord,pinnedIdentity:record.identity,pairing:{pairingId:record.scope.pairingId,ownerUserId:record.scope.ownerUserId},authorizeEnrollment:async()=>({...await this.client.enrollment(record.scope,record.identity),assertCurrent:()=>this._cached(record)})});this._cached(record);record.endpoint=endpoint}
  poll(){if(this.stopped||this.closing)return Promise.resolve();void this.monitor();if(this.pending)return this.pending;const task=this._poll().catch(error=>this._status(null,genericError(error)));this.pending=task;void task.finally(()=>{if(this.pending===task)this.pending=null}).catch(()=>{});return task}
  monitor(){
    if(this.stopped||this.closing)return Promise.resolve()
    const tasks=[]
    for(const record of this.records.values())if(record.runtime?.state==='active'){
      if(!record.monitorTask){const task=this._active(record).catch(error=>{if(!record.revoked)record.admission='unknown';this._status(record,genericError(error))});record.monitorTask=task;void task.finally(()=>{if(record.monitorTask===task)record.monitorTask=null}).catch(()=>{})}
      tasks.push(record.monitorTask)
    }
    return Promise.allSettled(tasks)
  }
  async _poll(){
    this.check();await this._load();this.check()
    const turn=this.cursor++,records=[...this.records.values()]
    if(records.length&&turn%3===0){const record=records[Math.floor(turn/3)%records.length];try{await this._step(record)}catch(error){if(record.runtime?.state==='active')record.admission='unknown';this._status(record,genericError(error))}return}
    if(this.candidates.size&&turn%3===1){const record=[...this.candidates.values()][Math.floor(turn/3)%this.candidates.size];await this._candidate(record);return}
    const ids=this.connection.pairing.assistantIds;if(!ids.length)return;const assistantId=ids[Math.floor(turn/3)%ids.length],result=await this.client.pending(assistantId,this.bootId);this.check()
    for(const intent of result.intents){if(intent.offer!==null||this.candidates.has(intent.intentId)||this.candidates.size>=16)continue;const endpoint=codec.createEndpointIdentity(randomUUID()),candidate={intent,endpoint,scope:{profileId:intent.profileId,actingUserId:intent.actingUserId,assistantId:intent.assistantId,endpointId:endpoint.identity.endpointId,keyFingerprint:codec.identityFingerprint(endpoint.identity),pairingId:intent.pairingId,ownerUserId:intent.ownerUserId},published:false,uncertain:false};this.candidates.set(intent.intentId,candidate);break}
    if(!this.candidates.size)this._status(null,'setup_required: Open Browser > Devices in HOAI to request this exact agent machine')
  }
  async _candidate(record){
    this.check();if(record.uncertain)return
    if(!record.published){record.published=true;try{await this.client.publish(record.intent,record.endpoint,this.bootId,this.deviceLabel);this.check();this.log(`managed browser public fingerprint for recipient ${record.scope.actingUserId}, agent ${record.scope.assistantId}: ${record.scope.keyFingerprint}`)}catch(error){record.uncertain=true;throw error}return}
    let entry;try{const result=await this.client.discover(record.scope,record.endpoint);this.check();entry=result.profiles[0]}catch(error){this._status(record,genericError(error));return}if(!entry){if(record.intent.expiresAt<=Date.now()){this.candidates.delete(record.intent.intentId);this._status(record,'setup_expired: create a new explicit device request')}else this._status(record,'background_grant_required');return}
    if(record.persisting)return;if(this.records.size>=64)throw fail('profile_companion_state_full');record.persisting=true
    try{const binding=this._binding(record,entry),keyRecord=await this.keyStore.protect({binding,endpoint:record.endpoint,assertCurrent:this.check});this.check();const saved=await this.stateStore.saveNew({version:1,scope:record.scope,identity:record.endpoint.identity,keyRecord},this.check);this.check();this.records.set(record.scope.endpointId,{...saved,endpoint:record.endpoint,runtime:null,admission:'blocked',revoked:false,uncertain:false,attempted:new Set(),engineTasks:new Set(),state:'saved'});this.candidates.delete(record.intent.intentId);this._status(record,'ready_for_explicit_session_request')}
    catch(error){record.uncertain=true;throw error}
  }
  async _step(record){
    await this._endpoint(record);this._cached(record)
    if(record.runtime?.state==='active')return
    if(record.uncertain||record.state==='closed')return
    record.peerPins=await new AgentProfilePeerPins({directory:path.join(this.directory,'peer-pins',record.scope.endpointId)}).list({scope:record.scope,ownIdentity:record.identity,assertCurrent:()=>this._cached(record)});this._cached(record)
    const entry=await this._discover(record)
    if(record.runtime){
      const status=await this.client.runtimeRequest(record.scope,record.endpoint,record.request.requestId);this._cached(record)
      if(status.state==='expired'){await this._dispose(record);this._status(record,'readiness_expired');return}
      if(status.state!=='confirmed')return
      if(record.request.purpose==='receive-transfer')return this._receiveTransfer(record,entry,status)
      const authority=shared.exactAuthority(status.confirmation.authority)
      if(!shared.sameAuthority(authority,record.runtime.authority))throw fail('profile_companion_authority_changed')
      await this._activate(record,authority);return
    }
    if(['fenced','quiescing'].includes(entry.profile.writerState)){this._status(record,'recovery_required');return}
    const requests=await this.client.pendingRuntimeRequests(record.scope,record.endpoint);this._cached(record)
    const status=requests.find(value=>value.state==='pending'&&!record.attempted.has(value.request.requestId))
    if(!status){if(entry.profile.writerState==='active')this._status(record,'active_elsewhere');else if(['stopped','staged'].includes(entry.profile.writerState))await this._restoreOwnStopped(record,entry);else this._status(record,'explicit_session_request_required');return}
    const request=status.request;if(request.expectedRevision!==entry.profile.revision||request.expectedHeadManifestHash!==entry.profile.headManifestHash||request.expectedWriterEpoch!==entry.profile.writerEpoch||request.grantVersion!==entry.grant.generation||request.contentKeyEpoch!==entry.profile.contentKeyEpoch||request.purpose==='start'&&(request.expectedRevision!==0||entry.profile.writerState!=='idle')||request.purpose==='receive-transfer'&&!['active','stopped','staged'].includes(entry.profile.writerState))throw fail('profile_companion_readiness_invalid')
    if(request.purpose==='receive-transfer'){
      record.sourcePin=entry.profile.endpointId===record.identity.endpointId?record.identity:record.peerPins.find(identity=>identity.endpointId===entry.profile.endpointId)
      if(!record.sourcePin){this._status(record,'reviewed_source_pin_required: compare the human source full fingerprint on this machine');return}
      record.expectedSource=source(entry.profile)
    }
    record.attempted.add(request.requestId);record.request=request
    const authority={profileId:record.scope.profileId,actingUserId:record.scope.actingUserId,assistantId:record.scope.assistantId,...destination({...record.scope,bootId:this.bootId,runtimeId:randomUUID(),sessionId:randomUUID(),grantVersion:entry.grant.generation}),writerEpoch:entry.profile.writerEpoch+1,revision:request.purpose==='start'?0:entry.profile.revision+(entry.profile.writerState==='active'?1:0),contentKeyEpoch:entry.profile.contentKeyEpoch}
    try{await this._prepare(record,authority);if(request.purpose==='start')record.contentKeyEpoch=codec.createContentKeyEpoch(authority.contentKeyEpoch);await this.client.ready(record.scope,record.endpoint,request,pick(authority,['bootId','runtimeId','sessionId']));this._cached(record);this._status(record,'waiting_for_human_session_confirmation')}
    catch(error){record.uncertain=true;await this._dispose(record);throw error}
  }
  _journal(record){
    const verifyRecord=({record:row})=>{const context=pick(row.checkpoint.manifest,['version','schemaVersion','profileId','actingUserId','assistantId','transitionId','revision','previousManifestHash','keyEpoch','source','destination']),sourcePin=context.source.endpointId===record.identity.endpointId?record.identity:record.peerPins?.find(identity=>identity.endpointId===context.source.endpointId),receiptPin=row.receipt.kind==='source-stopped'?sourcePin:record.identity;return Boolean(sourcePin&&receiptPin&&codec.verifyManifest({...row.checkpoint,sourceIdentity:sourcePin,expectedContext:context})&&verify(null,shared.canonical(row.receipt),{key:Buffer.from(receiptPin.signingPublicKey,'base64url'),type:'spki',format:'der'},Buffer.from(row.receiptSignature,'base64url')))}
    return new EncryptedCheckpointStore({dir:path.join(this.directory,'journals',record.scope.endpointId),verifyRecord,verifyAgentRecord:({record:row})=>verifyAgentStoppedHeadJournalRecord({record:row,endpointIdentity:record.identity})})
  }
  async _prepare(record,rawAuthority){
    this._cached(record);if(this.closing)throw fail('profile_companion_context_changed');if([...this.records.values()].filter(value=>value.runtime).length>=4)throw fail('profile_companion_runtime_capacity')
    const legacy=this.assertNoLegacyActive(record.scope);if(legacy?.then){void Promise.resolve(legacy).catch(()=>{});throw fail('profile_companion_legacy_runtime_active')}if(legacy!==true)throw fail('profile_companion_legacy_runtime_active')
    if(record.stopTask){await record.stopTask;this._cached(record);record.stopTask=null}
    record.processStop=null;record.runtimeCreating=null;record.engineCreating=null;record.extrasCreating=null
    let ownedReady;record.processOwned=new Promise(resolve=>{ownedReady=resolve})
    const preparation={};this.#preparations.set(record,preparation);let physicalRuntime
    const creatingCurrent=()=>{this._cached(record);if(this.closing||this.#preparations.get(record)!==preparation)throw fail('profile_companion_context_changed')}
    const authority=shared.exactAuthority(rawAuthority),binding={profileId:authority.profileId,actingUserId:authority.actingUserId,assistantId:authority.assistantId,endpointId:authority.endpointId,keyFingerprint:authority.keyFingerprint,grantVersion:authority.grantVersion,keyEpoch:authority.contentKeyEpoch,backgroundUse:true}
    const extrasCurrent=()=>{this._cached(record);if(this.#preparations.get(record)!==preparation||(physicalRuntime?record.runtime!==physicalRuntime:record.runtime!=null)||record.runtime&&!shared.sameAuthority(record.runtime.authority,authority)||['profileId','actingUserId','assistantId','endpointId','keyFingerprint'].some(key=>record.scope[key]!==authority[key]))throw fail('profile_companion_context_changed')}
    record.journal=this._journal(record);record.journalScope=pick(binding,['actingUserId','assistantId','profileId','endpointId','keyFingerprint','grantVersion'])
    try{
      record.extrasCreating=Promise.resolve().then(()=>{creatingCurrent();return this.preloadExtras({directory:path.join(this.directory,'runtime-extras',authority.runtimeId,authority.sessionId),binding,pinnedIdentity:record.identity,keyStore:this.keyStore,assertCurrent:extrasCurrent,createNew:true})}).then(extras=>{record.extras=extras;return extras})
      await record.extrasCreating;creatingCurrent()
      const {chromium,executable}=await this.loadBrowser();creatingCurrent()
      record.runtimeCreating=Promise.resolve().then(()=>{creatingCurrent();return this.createRuntime({chromium,executable,environment:this.environment,authority,transferQualificationFactory:createChromiumRtcActivity,
        onOwnedProcess:capability=>{if(record.processStop&&record.processStop!==capability)throw fail('profile_companion_process_replaced');record.processStop=capability;ownedReady();creatingCurrent()},
        preflightExtras:input=>record.extras.preflightExtras(input),captureExtras:input=>record.extras.captureExtras(input),commitExtras:input=>record.extras.commitExtras(input),
        closeAndDrain:async()=>{record.admission='stopping';record.permissionAbort?.abort();await this._drainCommands(record);this._cached(record);return{admissionClosed:true,drained:true}},
        checkpoint:async stopped=>{this._cached(record);const hash=codec.manifestHash(stopped.checkpoint.manifest),saved=await record.journal.write({scope:record.journalScope,checkpoint:stopped.checkpoint,manifestHash:hash,receipt:stopped.receipt,receiptSignature:stopped.signature,assertCurrent:()=>this._cached(record)});if(!saved.durability.fileSynced||!saved.durability.directorySynced)throw fail('profile_companion_journal_unproved');const read=await record.journal.read({scope:record.journalScope,expectedHead:{manifestHash:hash,revision:stopped.checkpoint.manifest.revision,keyEpoch:stopped.checkpoint.manifest.keyEpoch},assertCurrent:()=>this._cached(record)});if(!read||!same(read.checkpoint,stopped.checkpoint))throw fail('profile_companion_journal_unproved');return{durable:true,manifestHash:hash}},
        authorizeActivation:async()=>{const entry=await this._discover(record);if(!this._activeMatches(record,entry,authority))throw fail('profile_companion_authority_changed');return{authority,assertCurrent:()=>this._cached(record)}}})}).then(runtime=>{physicalRuntime=runtime;record.runtime=runtime;return runtime})
      await record.runtimeCreating;creatingCurrent()
    }catch(error){ownedReady();await this._dispose(record);throw error}finally{ownedReady()}
  }
  _activeMatches(record,entry,authority){return entry.profile.writerState==='active'&&entry.profile.id===authority.profileId&&entry.profile.actingUserId===authority.actingUserId&&entry.profile.assistantId===authority.assistantId&&['endpointId','bootId','runtimeId','sessionId','writerEpoch','revision','contentKeyEpoch'].every(key=>entry.profile[key]===authority[key])&&entry.grant.generation===authority.grantVersion&&entry.grant.backgroundUse===true&&record.scope.keyFingerprint===authority.keyFingerprint}
  async _receiveTransfer(record,entry,status){
    const runtime=record.runtime,authority=runtime.authority,check=()=>{this._cached(record);if(record.runtime!==runtime||this.closing)throw fail('profile_companion_context_changed')}
    check();if(!same(status.confirmation?.destination,destination(authority)))throw fail('profile_companion_readiness_invalid')
    if(runtime.state==='staged'){
      if(this._activeMatches(record,entry,authority))return this._activate(record,authority)
      this._status(record,'staged_inactive: waiting for human activation on HOAI');return
    }
    const pending=entry.pendingDestinations.find(value=>same(value.destination,destination(authority)))
    if(!pending||pending.phase==='awaiting_source'){this._status(record,'prepared_inactive: waiting for source checkpoint');return}
    if(record.stageAttempted)throw fail('profile_companion_stage_uncertain')
    const read=await this.client.transition(record.scope,record.endpoint,pending.transitionId);check();const transition=read.transition
    if(transition?.id!==pending.transitionId||transition.profileId!==record.scope.profileId||transition.kind!=='transfer'||transition.phase!=='checkpoint_committed'||read.profile?.writerState!=='stopped'||read.profile.headManifestHash!==transition.manifestHash||read.profile.revision!==authority.revision||read.profile.contentKeyEpoch!==authority.contentKeyEpoch||transition.source.writerEpoch+1!==authority.writerEpoch||!same(transition.source,record.expectedSource)||!same(transition.destination,destination(authority))||!read.admission?.source?.admitted||read.admission.source.keyFingerprint!==codec.identityFingerprint(record.sourcePin)||!read.admission?.destination?.admitted||!read.admission.destination.backgroundUse||read.admission.destination.grantVersion!==authority.grantVersion||read.admission.destination.keyFingerprint!==authority.keyFingerprint)throw fail('profile_companion_transfer_changed')
    const checkpoint=await this.client.capsule(record.scope,record.endpoint,transition);check()
    const context={version:1,schemaVersion:1,profileId:record.scope.profileId,actingUserId:record.scope.actingUserId,assistantId:record.scope.assistantId,transitionId:transition.id,revision:transition.sourceRevision+1,previousManifestHash:transition.sourceManifestHash,keyEpoch:transition.contentKeyEpoch,source:transition.source,destination:transition.destination}
    if(codec.manifestHash(checkpoint.manifest)!==transition.manifestHash||!codec.verifyManifest({...checkpoint,expectedContext:context,sourceIdentity:record.sourcePin}))throw fail('profile_companion_source_pin_changed')
    record.stageAttempted=true;record.transferId=transition.id
    try{const staged=await runtime.stage({checkpoint,expectedContext:context,sourceIdentity:record.sourcePin,destination:record.endpoint});check();const saved=await record.journal.write({scope:record.journalScope,checkpoint,manifestHash:transition.manifestHash,receipt:staged.receipt,receiptSignature:staged.signature,assertCurrent:check});check();if(!saved.durability.fileSynced||!saved.durability.directorySynced)throw fail('profile_companion_journal_unproved');const loaded=await record.journal.read({scope:record.journalScope,expectedHead:head(read.profile),assertCurrent:check});check();if(!loaded||!same(loaded.checkpoint,checkpoint)||!same(loaded.receipt,staged.receipt))throw fail('profile_companion_journal_unproved');const acknowledged=await this.client.staged(record.scope,record.endpoint,transition.id,staged);check();if(acknowledged.writerState!=='staged'||acknowledged.headManifestHash!==transition.manifestHash||acknowledged.revision!==authority.revision)throw fail('profile_companion_stage_uncertain');this._status(record,'staged_inactive: waiting for human activation on HOAI')}
    catch(error){record.uncertain=true;await this._dispose(record);throw error}
  }
  async _activate(record,authority){
    if(this.closing)throw fail('profile_companion_context_changed')
    const runtime=record.runtime,check=()=>{this._cached(record);if(this.closing||record.runtime!==runtime||!shared.sameAuthority(runtime.authority,authority))throw fail('profile_companion_context_changed')}
    check();const entry=await this._discover(record);check();if(!this._activeMatches(record,entry,authority))throw fail('profile_companion_authority_changed')
    await runtime.activate(authority);check();await runtime.newPage();check()
    record.engineCreating=Promise.resolve().then(()=>this.createEngine({runtime,directory:path.join(this.directory,'artifacts',authority.runtimeId)})).then(engine=>{record.engine=engine;return engine});await record.engineCreating;check()
    const currentExecution=()=>{const execution=this.#executions.getStore();if(!execution||execution.record!==record)throw fail('profile_companion_context_changed');execution.check();return execution}
    record.relay=this.createRelay({roster:()=>{currentExecution();return record.engine.roster()},callTool:(_context,name,args,signal)=>{currentExecution();return this._tool(record,name,args,signal)}})
    const rpc=createPairedProfileRuntimeEndpoint({authority,endpoint:record.endpoint,client:this.rpcClient,assertCurrent:()=>this._admit(record),execute:async({frame,signal,assertCurrent})=>{
      assertCurrent();signal.throwIfAborted()
      const runtime=record.runtime,engine=record.engine,relay=record.relay,endpoint=record.endpoint,binding=rpc.binding,originalAuthority=shared.exactAuthority(frame.authority),messageBytes=JSON.stringify(frame.message),snapshot=JSON.parse(JSON.stringify(frame))
      const execution={record,frame:snapshot,signal,rpc,binding,runtime,engine,relay,claimed:false,check:()=>{
        assertCurrent();this._admit(record);signal.throwIfAborted()
        if(record.execution!==execution||record.runtime!==runtime||record.engine!==engine||record.relay!==relay||record.endpoint!==endpoint||record.rpc!==rpc||rpc.binding!==binding||!binding||this.connection.socketId!==binding.socketId||this.connection.socket?.connected!==true||JSON.stringify(snapshot.message)!==messageBytes||!shared.sameAuthority(runtime.authority,originalAuthority)||!shared.sameAuthority(rpc.authority,originalAuthority)||!shared.sameAuthority(binding.authority,originalAuthority)||['profileId','actingUserId','assistantId','endpointId','keyFingerprint'].some(key=>record.scope[key]!==originalAuthority[key]))throw fail('profile_companion_context_changed')
      }}
      record.execution=execution;execution.check()
      try{return await this.#executions.run(execution,()=>relay.relay({...snapshot,principal:`user-${authority.actingUserId}`}))}
      finally{try{await Promise.all([...record.engineTasks]);execution.check()}finally{if(record.execution===execution)record.execution=null}}
    }});record.rpc=rpc
    record.admission='active';record.state='active';await this._prove(record);this._status(record,'active')
  }
  async _prove(record){this._admit(record);const socket=this.connection.socket,socketId=this.connection.socketId;if(!socketId||!socket?.connected)throw fail('profile_companion_connection_unavailable');await record.rpc.prove({socketId,exchange:(event,body)=>new Promise((resolve,reject)=>{if(this.connection.socketId!==socketId||!socket.connected)return reject(fail('profile_companion_connection_unavailable'));socket.emit(event,body,reply=>resolve(reply))})});this._admit(record)}
  async _active(record){
    const runtime=record.runtime,rpc=record.rpc,binding=rpc?.binding,unchanged=()=>record.runtime===runtime&&record.rpc===rpc&&rpc?.binding===binding
    if(!binding||binding.socketId!==this.connection.socketId){const entry=await this._discover(record);if(!this._activeMatches(record,entry,record.runtime.authority))throw fail('profile_companion_authority_changed');record.admission='active';await this._prove(record);return}
    const statusClient=this.statusClient||(record.statusClient??=this.statusClientFactory())
    let result;try{result=await statusClient.status({authority:runtime.authority,endpoint:record.endpoint,bindingId:binding.bindingId,socketId:binding.socketId,assertCurrent:()=>{this._cached(record);if(!unchanged())throw fail('profile_companion_context_changed')}})}catch{if(!unchanged())return;record.admission='unknown';this._status(record,'authority_unknown: new agent actions paused; live page retained');return}
    this._cached(record);if(!unchanged())return;if(result.current===false){record.revoked=true;record.admission='revoked';await this._dispose(record);this._status(record,'revoked');return}record.admission='active';this._status(record,'active')
  }
  async _tool(record,name,args,signal){
    this._admit(record);signal?.throwIfAborted();const execution=this.#executions.getStore()
    if(execution){execution.check();if(execution.record!==record||execution.claimed||execution.frame.message.method!=='tools/call'||execution.frame.message.params?.name!==name||!same(execution.frame.message.params.arguments??{},args))throw fail('profile_companion_command_changed');execution.claimed=true;args=JSON.parse(JSON.stringify(execution.frame.message.params.arguments??{}))}
    if(name==='hoai_browser_close_session'||name==='browser_close'){await this.retire(record);return{content:[{type:'text',text:'The browser stopped and its encrypted checkpoint was committed through HOAI.'}]}}
    if(name==='hoai_browser_open_session'||name==='hoai_browser_status')return{content:[{type:'text',text:'Managed browser is active on the agent machine. Saved state is encrypted locally. Owner control uses HOAI.'}]}
    const controller=new AbortController(),signals=[signal,execution?.signal].filter(Boolean),abort=()=>controller.abort()
    for(const source of signals){source.addEventListener('abort',abort,{once:true});if(source.aborted)abort()}
    const engine=record.engine,check=()=>{this._admit(record);controller.signal.throwIfAborted();if(record.engine!==engine)throw fail('profile_companion_context_changed');execution?.check()}
    let physicalClean=true
    const work=Promise.resolve().then(async()=>{
      check()
      const classification=policy.classifyToolCall(name,args,{currentOrigin:policy.originOf(engine.selectedPage()?.url())}),decision=policy.decide({profile:'signed-in',classification,grants:{},settings:settings.defaultSettings(),preapproved:[]})
      if(classification.kind==='credential'||['browser_type','browser_press_key','browser_press_sequentially','browser_keydown','browser_keyup','browser_fill_form','browser_evaluate'].includes(name)||classification.kind==='vision')return toolError('recipient_handover_required','This action requires the person to use the browser directly. It did not run.')
      if(decision.verdict==='deny')return toolError('recipient_policy_denied','This action is blocked by the browser policy. It did not run.')
      if(classification.kind!=='read'&&(!permissionTools.has(name)||decision.verdict!=='ask'))return toolError('recipient_handover_required','This action has no supported recipient permission. It did not run.')
      if(decision.verdict==='allow'){check();return engine.callTool(name,args,controller.signal)}
      if(!execution)return toolError('recipient_permission_required','This action requires its original recipient-scoped request. It did not run.')
      record.permissionAbort=controller
      try{return await this.permissionRunner.run({frame:execution.frame,binding:execution.binding,endpoint:record.endpoint,engine,assertCurrent:check,signal:controller.signal,execute:(tool,originalArgs,originalSignal)=>{check();return engine.callTool(tool,originalArgs,originalSignal)}})}
      finally{try{await this.permissionClient.whenDrained();this.permissionRunner.assertCleanupConfirmed()}catch(error){physicalClean=false;this.#permissionCleanupUnknown.add(record);throw error}finally{if(record.permissionAbort===controller)record.permissionAbort=null}}
    });record.engineTasks.add(work)
    try{return await work}finally{for(const source of signals)source.removeEventListener('abort',abort);if(physicalClean)record.engineTasks.delete(work)}
  }
  receive(frame,socketId){const record=[...this.records.values()].find(value=>value.rpc&&shared.sameAuthority(value.runtime?.authority,frame.authority));if(!record)return Promise.reject(fail('profile_companion_runtime_unavailable'));const hint={rpcId:frame.rpcId,rpcNonce:frame.rpcNonce,bindingId:frame.bindingId,socketId,authority:frame.authority};return frame.event_type==='browser_profile_rpc_cancel'?record.rpc.cancel(hint):record.rpc.receive(hint)}
  disconnected(){for(const record of this.records.values()){record.admission='unknown';record.permissionAbort?.abort();record.rpc?.disconnect();this._status(record,'connection_unknown: new agent actions paused; live page retained')}}
  async retire(record,shutdown=false){
    if(shutdown){this._cached(record);record.runtime.assertCurrent()}else this._admit(record);const authority=record.runtime.authority,entry=record.entry,context={version:1,schemaVersion:1,profileId:authority.profileId,actingUserId:authority.actingUserId,assistantId:authority.assistantId,transitionId:randomUUID(),revision:authority.revision+1,previousManifestHash:entry.profile.headManifestHash,keyEpoch:authority.contentKeyEpoch,source:source(authority),destination:{...destination(authority),bootId:randomUUID(),runtimeId:randomUUID(),sessionId:randomUUID()}}
    let stopped;try{stopped=await record.runtime.finalize({context,source:record.endpoint,destinationIdentity:record.identity,contentKeyEpoch:record.contentKeyEpoch||record.runtime.contentKeyEpoch});this._cached(record);record.state='local_stopped';const result=await this.client.retire(authority,record.endpoint,stopped);this._cached(record);if(result.profile?.writerState!=='stopped'||result.profile.headManifestHash!==codec.manifestHash(stopped.checkpoint.manifest)||result.transition?.id!==context.transitionId||result.transition.phase!=='checkpoint_committed')throw fail('profile_companion_retirement_unconfirmed');record.state='closed';await this._dispose(record);this._status(record,'server_committed_stopped')}
    catch(error){if(stopped||record.runtime?.state!=='active')record.uncertain=true;else record.admission='active';this._status(record,genericError(error));throw error}
  }
  async _restoreOwnStopped(record,entry){
    if(record.restoreAttempted)return;record.restoreAttempted=true;record.journal=this._journal(record);record.journalScope={...pick(record.scope,['actingUserId','assistantId','profileId','endpointId','keyFingerprint']),grantVersion:entry.grant.generation}
    const saved=await record.journal.read({scope:record.journalScope,expectedHead:head(entry.profile),assertCurrent:()=>this._cached(record)});this._cached(record)
    if(!saved||saved.checkpoint.manifest.source.endpointId!==record.scope.endpointId){this._status(record,'recovery_required: no same-endpoint stopped checkpoint');return}
    const status=await this.client.transition(record.scope,record.endpoint,saved.receipt.transitionId,'source');this._cached(record)
    if(status.profile?.writerState!=='stopped'||status.transition?.phase!=='checkpoint_committed'||status.profile.headManifestHash!==saved.manifestHash){this._status(record,'recovery_required: stopped state changed');return}
    const target={...saved.checkpoint.manifest.destination,bootId:this.bootId,runtimeId:randomUUID(),sessionId:randomUUID()},request={transitionId:randomUUID(),expectedTransitionId:status.transition.id,manifestHash:saved.manifestHash,expectedRevision:entry.profile.revision,expectedWriterEpoch:entry.profile.writerEpoch,expectedKeyEpoch:entry.profile.contentKeyEpoch,destination:target}
    const authority={...pick(record.scope,['profileId','actingUserId','assistantId']),...target,writerEpoch:request.expectedWriterEpoch+1,revision:request.expectedRevision,contentKeyEpoch:request.expectedKeyEpoch}
    try{const response=await this.client.readdress(record.scope,record.endpoint,request);this._cached(record);const document={version:1,kind:'agent-stopped-head-readdress',...pick(record.scope,['profileId','actingUserId','assistantId']),...request},authorization=createAgentStoppedHeadStageAuthorization({authority,document,signature:shared.documentSignature(record.endpoint,document),response,checkpoint:saved.checkpoint,sourceIdentity:record.identity,destination:record.endpoint,assertCurrent:()=>this._cached(record)});await this._prepare(record,authority);const staged=await record.runtime.stageStoppedHead({checkpoint:saved.checkpoint,originalContext:response.originalContext,sourceIdentity:record.identity,destination:record.endpoint,authorization});this._cached(record)
      await record.journal.write({scope:record.journalScope,checkpoint:saved.checkpoint,manifestHash:saved.manifestHash,receipt:staged.receipt,receiptSignature:staged.signature,readdress:staged.readdress,assertCurrent:()=>this._cached(record)});await record.journal.read({scope:record.journalScope,expectedHead:head(response.profile),assertCurrent:()=>this._cached(record)});this._cached(record);await this.client.staged(record.scope,record.endpoint,response.transition.id,staged);this._cached(record);const activated=await this.client.resume(record.scope,record.endpoint,response.transition);this._cached(record);if(!shared.sameAuthority(shared.exactAuthority(activated),authority))throw fail('profile_companion_authority_changed');await this._activate(record,authority)
    }catch(error){record.uncertain=true;await this._dispose(record);throw error}
  }
  _dispose(record){
    record.admission='blocked';this.#preparations.delete(record);record.permissionAbort?.abort();record.rpc?.disconnect?.();if(record.stopTask)return record.stopTask
    const task=Promise.resolve().then(async()=>{const failures=[];await record.runtimeCreating?.catch(()=>{});const native=Promise.resolve().then(()=>record.runtime?.dispose()),commands=Promise.resolve().then(()=>this._drainCommands(record));for(const result of await Promise.allSettled([native,commands]))if(result.status==='rejected')failures.push(result.reason);for(const cleanup of [async()=>{await record.engineCreating?.catch(()=>{});await record.engine?.stop()},async()=>{await record.extrasCreating?.catch(()=>{});record.extras?.dispose()}])try{await cleanup()}catch(error){failures.push(error)}record.contentKeyEpoch?.key.fill(0);record.contentKeyEpoch=null;if(failures.length)throw fail('profile_companion_stop_unconfirmed');record.relay?.close();record.runtime=null;record.engine=null;record.extras=null;if(record.rpc){void record.rpc.close().catch(()=>{});record.rpc=null}})
    record.stopTask=task;return task
  }
  async stop(){if(this.stopped)return;this.closing=true;for(const record of this.records.values())if(record.runtime?.state==='active')await this.retire(record,true);this.stopped=true;for(const record of this.records.values())await this._dispose(record);this.candidates.clear()}
  async emergencyTerminate(){
    this.closing=true;this.stopped=true
    const results=await Promise.allSettled([...this.records.values()].map(async record=>{
      record.revoked=true;record.uncertain=true;record.admission='revoked';record.permissionAbort?.abort();record.rpc?.disconnect();record.contentKeyEpoch?.key.fill(0);record.contentKeyEpoch=null
      if(record.runtime||record.runtimeCreating){await record.processOwned;if(!record.processStop||typeof record.processStop.stop!=='function')throw fail('profile_companion_stop_unconfirmed');const result=await record.processStop.stop();if(result?.stopped!==true)throw fail('profile_companion_stop_unconfirmed');await record.runtime?.emergencyStopOwnedProcess()}
      await this._drainCommands(record);record.extras?.dispose();this._status(record,'recovery_required: explicit daemon termination; no new stopped checkpoint is confirmed')
    }))
    this.candidates.clear();if(results.some(result=>result.status==='rejected'))throw fail('profile_companion_stop_unconfirmed');return{stopped:true,recoveryRequired:true}
  }
  async revoke(){this.closing=true;this.stopped=true;for(const record of this.records.values()){record.revoked=true;record.admission='revoked'}const results=await Promise.allSettled([...this.records.values()].map(record=>this._dispose(record)));this.candidates.clear();if(results.some(result=>result.status==='rejected'))throw fail('profile_companion_stop_unconfirmed')}
}
