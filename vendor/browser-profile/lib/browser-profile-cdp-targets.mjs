import { createRequire } from 'node:module'
import { profileLaunchArguments } from './browser-profile-launch.mjs'
const require=createRequire(import.meta.url)
const fail=code=>Object.assign(new Error(code),{code,reason:code})
const id=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,256}$/.test(value)
const MAX_SESSIONS=2048,MAX_HISTORY=8192,MAX_COMMANDS=4096,MAX_PER_SESSION=128

// The exact in-process Playwright implementation is pinned before any private
// field is read. Child sessions use the original owned Chromium pipe only.
export function createPinnedProfileTargetSessions({browser,root,timeoutMs=5000}){
  profileLaunchArguments()
  if(!browser?.on||!browser.removeListener||!browser.isConnected||!root?.on||!root.removeListener||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw fail('profile_target_native_binding_invalid')
  const client=root._connection,toImpl=client?.toImpl
  if(!client||client!==require('playwright-core').chromium._connection||browser._connection!==client||typeof toImpl!=='function'||!(client._objects instanceof Map))throw fail('profile_target_native_binding_invalid')
  let serverRoot,serverBrowser,dispatcher
  try{serverRoot=toImpl.call(client,root);serverBrowser=toImpl.call(client,browser);dispatcher=toImpl.call(client,client)}catch{throw fail('profile_target_native_binding_invalid')}
  const nativeRoot=serverRoot?._session,wire=serverBrowser?._connection,transport=wire?._transport,transportSend=transport?.send,rawSend=wire?._rawSend,childFactory=nativeRoot?.createChildSession,rootId=nativeRoot?._sessionId,rootSend=nativeRoot?.send,rootCallbacks=nativeRoot?._callbacks,sessionDispose=nativeRoot?.dispose,rejectCallbacks=nativeRoot?._rejectPendingCallbacks
  const pending=new Map(),owned=new Map(),seen=new Set(),capabilities=new WeakMap(),physical=new Set()
  let disposed=false,unknown=null,subscriber=null,closed=false
  const poison=()=>{unknown||='profile_target_native_unproved';try{subscriber?.failure(unknown)}catch{}}
  const identity=()=>{
    if(root._connection!==client||browser._connection!==client||client.toImpl!==toImpl||client._objects.get(root._guid)!==root||client._objects.get(browser._guid)!==browser||toImpl.call(client,root)!==serverRoot||toImpl.call(client,browser)!==serverBrowser||toImpl.call(client,client)!==dispatcher||dispatcher?._dispatcherByGuid?.get(root._guid)?._object!==serverRoot||dispatcher?._dispatcherByGuid?.get(browser._guid)?._object!==serverBrowser||serverRoot?._session!==nativeRoot||serverBrowser?._connection!==wire||!(wire?._sessions instanceof Map)||wire._transport!==transport||wire._rawSend!==rawSend||typeof rawSend!=='function'||typeof transportSend!=='function'||transport.send!==transportSend||nativeRoot?._connection!==wire||!id(rootId)||nativeRoot._sessionId!==rootId||nativeRoot._parentSession!==wire.rootSession||wire.rootSession?._sessionId!==''||wire.rootSession?._parentSession!==null||wire.rootSession?._connection!==wire||wire._sessions.get('')!==wire.rootSession||wire._sessions.get(rootId)!==nativeRoot||nativeRoot.createChildSession!==childFactory||typeof childFactory!=='function'||nativeRoot.send!==rootSend||typeof rootSend!=='function'||nativeRoot._callbacks!==rootCallbacks||!(rootCallbacks instanceof Map)||nativeRoot.dispose!==sessionDispose||typeof sessionDispose!=='function'||nativeRoot._rejectPendingCallbacks!==rejectCallbacks||typeof rejectCallbacks!=='function'||nativeRoot._closed!==false||wire._closed!==false||!browser.isConnected())throw fail('profile_target_native_binding_invalid')
  }
  try{identity()}catch{throw fail('profile_target_native_binding_invalid')}
  const check=()=>{if(disposed||closed||unknown)throw fail('profile_target_native_unproved');try{identity()}catch{poison();throw fail('profile_target_native_unproved')}}
  const recordCurrent=record=>{
    check()
    if(record.root)return
    if(record.detached||owned.get(record.sessionId)!==record||wire._sessions.get(record.sessionId)!==record.native||record.native._connection!==wire||record.native._parentSession!==record.parent||record.native._sessionId!==record.sessionId||record.native._closed!==false||record.native.send!==rootSend||record.native.createChildSession!==childFactory||record.native._eventListener!==record.event||record.native.dispose!==sessionDispose||record.native._rejectPendingCallbacks!==rejectCallbacks||record.native._callbacks!==record.callbacks) {poison();throw fail('profile_target_native_unproved')}
  }
  const safeDispose=record=>{if(wire._sessions.get(record.sessionId)!==record.native||record.native._connection!==wire||record.native._sessionId!==record.sessionId||record.native.dispose!==sessionDispose||record.native._rejectPendingCallbacks!==rejectCallbacks||record.native._callbacks!==record.callbacks){poison();return false}try{sessionDispose.call(record.native);return true}catch{poison();return false}}
  const terminal=(record,notify=true)=>{
    if(!record||record.detached)return
    record.detached=true
    for(const token of record.commands)token.terminal=true
    safeDispose(record)
    owned.delete(record.sessionId)
    if(notify)subscriber?.detached({sessionId:record.sessionId})
  }
  const detached=({sessionId})=>{const receipt=pending.get(sessionId);if(receipt)pending.delete(sessionId);const record=owned.get(sessionId);if(record)terminal(record);else if(receipt)subscriber?.detached({sessionId})}
  const attached=(value,parentSessionId=null)=>{
    if(disposed||closed)return
    try{
      check()
      if(!value||!id(value.sessionId)||!id(value.targetInfo?.targetId)||typeof value.targetInfo.type!=='string'||typeof value.waitingForDebugger!=='boolean'||seen.has(value.sessionId)||pending.size>=MAX_SESSIONS||seen.size>=MAX_HISTORY||JSON.stringify(value).length>65536||parentSessionId!==null&&!owned.has(parentSessionId))throw fail('profile_target_native_attachment_invalid')
      const receipt=Object.freeze({sessionId:value.sessionId,targetInfo:Object.freeze(structuredClone(value.targetInfo)),waitingForDebugger:value.waitingForDebugger,parentSessionId})
      seen.add(value.sessionId);pending.set(value.sessionId,receipt);subscriber?.attached(receipt)
    }catch{poison()}
  }
  const rootAttached=value=>attached(value),rootDetached=value=>{if(!disposed)detached(value)},rootClosed=()=>{poison();dispose()}
  const disconnected=()=>{closed=true;for(const token of physical)token.terminal=true;for(const record of [...owned.values()])terminal(record,false);browser.removeListener('disconnected',disconnected)}
  root.on('Target.attachedToTarget',rootAttached);root.on('Target.detachedFromTarget',rootDetached);root.on('close',rootClosed);browser.on('disconnected',disconnected)
  const rootCapability=Object.freeze(Object.create(null));capabilities.set(rootCapability,{root:true,native:nativeRoot,parent:wire.rootSession,sessionId:rootId,send:rootSend,detached:false,commands:new Set()})
  const claim=receipt=>{
    check()
    if(pending.get(receipt?.sessionId)!==receipt||owned.size>=MAX_SESSIONS||wire._sessions.has(receipt.sessionId)){poison();throw fail('profile_target_native_attachment_invalid')}
    const parentRecord=receipt.parentSessionId===null?null:owned.get(receipt.parentSessionId)
    if(parentRecord)recordCurrent(parentRecord)
    const parent=receipt.parentSessionId===null?nativeRoot:parentRecord?.native
    if(!parent||parent._connection!==wire||parent._closed!==false||parent.createChildSession!==childFactory){poison();throw fail('profile_target_native_attachment_invalid')}
    pending.delete(receipt.sessionId)
    const record=/** @type {any} */({sessionId:receipt.sessionId,targetId:receipt.targetInfo.targetId,parent,native:null,send:null,detached:false,commands:new Set()})
    const event=(method,params)=>{
      if(disposed||closed||record.detached)return
      try{recordCurrent(record);if(method==='Target.attachedToTarget')attached(params,record.sessionId);else if(method==='Target.detachedFromTarget')detached(params);else subscriber?.event({sessionId:record.sessionId,method,params})}catch{poison()}
    }
    try{
      record.event=event;record.native=parent.createChildSession(receipt.sessionId,event);record.send=record.native?.send;record.callbacks=record.native?._callbacks;if(!(record.callbacks instanceof Map))throw fail('profile_target_native_binding_invalid');owned.set(receipt.sessionId,record);recordCurrent(record)
    }catch{poison();if(record.native)safeDispose(record);owned.delete(receipt.sessionId);throw fail('profile_target_native_attachment_invalid')}
    const capability=Object.freeze(Object.create(null));record.capability=capability;capabilities.set(capability,record);return capability
  }
  const send=(capability,method,params={})=>{
    let record
    try{record=capabilities.get(capability);if(!record)throw fail('profile_target_native_attachment_invalid');recordCurrent(record);if(physical.size>=MAX_COMMANDS||record.commands.size>=MAX_PER_SESSION)throw fail('profile_inventory_limit');if(typeof method!=='string'||!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method)||JSON.stringify(params).length>1024*1024)throw fail('profile_target_native_command_invalid')}catch(error){return Promise.reject(error)}
    // Reserve before dispatch. Logical timeout and browser closure never remove
    // the token; only the original native promise's settlement does.
    const token={terminal:false};physical.add(token);record.commands.add(token)
    let operation
    try{operation=record.native.send(method,params)}catch(error){operation=Promise.reject(error)}
    const actual=Promise.resolve(operation)
    void actual.finally(()=>{physical.delete(token);record.commands.delete(token)}).catch(()=>{})
    let timer
    const deadline=new Promise((_resolve,reject)=>{timer=setTimeout(()=>{poison();reject(fail('profile_target_native_command_timeout'))},timeoutMs)})
    return Promise.race([actual,deadline]).then(value=>{recordCurrent(record);return value},()=>{if(!disposed&&!record.detached&&!closed)poison();throw fail('profile_target_native_unproved')}).finally(()=>clearTimeout(timer))
  }
  const releaseDuplicate=async receipt=>{
    const capability=claim(receipt),record=capabilities.get(capability)
    try{if(receipt.waitingForDebugger)await send(capability,'Runtime.runIfWaitingForDebugger');recordCurrent(record);await send(receipt.parentSessionId===null?rootCapability:owned.get(receipt.parentSessionId)?.capability,'Target.detachFromTarget',{sessionId:record.sessionId});terminal(record)}catch{poison();throw fail('profile_target_native_unproved')}
  }
  function dispose(){
    if(disposed)return
    disposed=true;root.removeListener('Target.attachedToTarget',rootAttached);root.removeListener('Target.detachedFromTarget',rootDetached);root.removeListener('close',rootClosed);pending.clear();subscriber=null
    for(const record of owned.values()){safeDispose(record)}
    owned.clear()
    if(!physical.size||closed)browser.removeListener('disconnected',disconnected)
  }
  return Object.freeze({
    subscribe(callbacks){check();if(subscriber||!['attached','detached','event','failure'].every(key=>typeof callbacks?.[key]==='function'))throw fail('profile_target_native_binding_invalid');subscriber=callbacks;return()=>{if(subscriber===callbacks)subscriber=null}},
    claim,send,releaseDuplicate,
    assertQualified(){check();if(pending.size)throw fail('profile_target_native_unproved');return true},
    activity(){return Object.freeze({activeSessions:owned.size,pendingRegistrations:pending.size,pendingCommands:physical.size,cleanupUnknown:!!unknown,disposed})},
    dispose,
  })
}
