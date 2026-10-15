import {createRequire} from 'node:module'
import {DOCUMENT_SAFETY_EXPRESSION} from './browser-profile-document-safety.mjs'
const require=createRequire(import.meta.url),{exactAuthority,sameAuthority,canonical}=require('./browser-profile-core/coordinator-client.js'),{createStorageAdapter}=require('./browser-profile-core/storage.js'),{readLiveStorage}=require('./browser-profile-core/live-storage-reader.js')
const reservations=new WeakMap(),leases=new Set(),fail=code=>Object.assign(new Error(code),{code})
const sync=callback=>{const value=callback();if(value?.then){void Promise.resolve(value).catch(()=>{});throw fail('profile_live_async_proof')}if(value===false)throw fail('profile_live_context_changed');return value}
const same=(a,b)=>canonical(a).equals(canonical(b)),id=value=>typeof value==='string'&&value.length>0&&value.length<=512
const frameURL=frame=>{if(typeof frame?.url!=='string'||frame.url.length>16384)return null;const fragment=frame.urlFragment;if(fragment===undefined)return frame.url;if(typeof fragment!=='string'||fragment.length>16384||!fragment.startsWith('#')||frame.url.includes('#'))return null;return frame.url+fragment}
const keyPath=value=>{if(value?.type==='null'&&Object.keys(value).length===1)return null;if(value?.type==='string'&&Object.keys(value).length===2&&typeof value.string==='string'&&value.string.length<=1024)return value.string;if(value?.type==='array'&&Object.keys(value).length===2&&Array.isArray(value.array)&&value.array.length<=100&&value.array.every(row=>typeof row==='string'&&row.length<=1024))return value.array;throw fail('profile_live_schema_unsupported')}

/** Main-only readonly native capability. No page, caller script or relay can
 * choose CDP methods or evaluate source. It never pauses a document or network. */
export async function openAgentLiveReadScope({runtime,authority:rawAuthority,assertCurrent,protection,timeoutMs=5000}){
 if(!runtime||[assertCurrent,protection,runtime.assertCurrent,runtime.assertMovable,runtime.assertTransferAllowed,runtime._assertTransportQualified].some(value=>typeof value!=='function')||reservations.has(runtime)||leases.size>=4||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw fail('profile_live_busy_or_invalid')
 const authority=exactAuthority(rawAuthority),context=runtime.context,browser=runtime.browser,root=runtime.root,ledger=runtime.ledger,contextId=runtime.contextId,original=assertCurrent,originalRuntimeCheck=runtime.assertCurrent,originalMovable=runtime.assertMovable,originalSafety=runtime.assertTransferAllowed,originalQualified=runtime._assertTransportQualified,deadline=Date.now()+timeoutMs,initialProtection=sync(protection)
 if(!context||typeof context.pages!=='function'||typeof context.newCDPSession!=='function'||typeof context.on!=='function'||typeof context.removeListener!=='function'||!browser||!root||!ledger||!id(contextId)||!initialProtection||initialProtection.blocked!==false||typeof initialProtection.version!=='string'||!initialProtection.version||initialProtection.version.length>256)throw fail('profile_live_credentials_protected')
 const version=initialProtection.version,token={},pending=new Set(),sessions=[],listeners=[],records=new Map(),pageRecords=[];let released=false,changed=false,cleanupWork=null,cleanupUnknown=false,origins=null,generation=null
 const pages=context.pages().filter(page=>!runtime.privatePages.has(page));if(!pages.length||pages.length>32)throw fail('profile_live_origin_unavailable')
 const check=()=>{
  sync(original);const guard=sync(protection)
  if(released||changed||Date.now()>deadline||runtime.context!==context||runtime.browser!==browser||runtime.root!==root||runtime.ledger!==ledger||runtime.contextId!==contextId||runtime.assertCurrent!==originalRuntimeCheck||runtime.assertMovable!==originalMovable||runtime.assertTransferAllowed!==originalSafety||runtime._assertTransportQualified!==originalQualified||runtime.operation!==null||runtime.state!=='active'||runtime.network!=='active'||!sameAuthority(sync(()=>originalRuntimeCheck.call(runtime)),authority)||!guard||guard.blocked!==false||guard.version!==version)throw fail('profile_live_context_changed')
  const current=context.pages().filter(page=>!runtime.privatePages.has(page));if(current.length!==pages.length||current.some((page,index)=>page!==pages[index]))throw fail('profile_live_inventory_changed')
  if(generation!==null&&ledger.generation!==generation)throw fail('profile_live_inventory_changed');ledger.assertIdle(contextId)
  for(const record of pageRecords)if(record.page.isClosed()||record.page.mainFrame()!==record.frame||record.frame.isDetached()||record.frame.url()!==record.url)throw fail('profile_live_document_changed')
 }
 const changedListener=()=>{changed=true}
 const cleanup=()=>{
  if(cleanupWork)return cleanupWork;if(!released||pending.size)return Promise.resolve()
  const work=(async()=>{const callbacks=[...listeners.map(([target,event])=>()=>sync(()=>target.removeListener(event,changedListener))),...sessions.map(session=>()=>session.detach())],results=await Promise.allSettled(callbacks.map(callback=>Promise.resolve().then(callback)));if(results.some(result=>result.status==='rejected')){cleanupUnknown=true;throw fail('profile_live_cleanup_unknown')}reservations.delete(runtime);leases.delete(token)})();cleanupWork=work;void work.catch(()=>{});return work
 }
 /** @template T @param {()=>T|Promise<T>} callback @returns {Promise<T>} */
 const track=callback=>{const physical=Promise.resolve().then(callback);pending.add(physical);void physical.finally(()=>{pending.delete(physical);if(released)void cleanup().catch(()=>{})}).catch(()=>{});return physical}
 const command=async(record,method,params={})=>{check();const value=await record.session.send(method,params);check();return value}
 const bind=async record=>{const info=(await command(record,'Target.getTargetInfo')).targetInfo,frame=(await command(record,'Page.getFrameTree')).frameTree?.frame;if(info?.browserContextId!==contextId||info.type!=='page'||!id(info.targetId)||record.targetId&&record.targetId!==info.targetId||!frame||frame.parentId||!id(frame.id)||!id(frame.loaderId)||frameURL(frame)!==record.url||record.frameId&&record.frameId!==frame.id||record.loaderId&&record.loaderId!==frame.loaderId)throw fail('profile_live_document_changed');record.targetId=info.targetId;record.frameId=frame.id;record.loaderId=frame.loaderId;const{storageKey}=await command(record,'Storage.getStorageKeyForFrame',{frameId:frame.id});if(storageKey!==record.origin+'/')throw fail('profile_live_partition_unsupported');record.storageKey=storageKey}
 const safety=async()=>{
  await originalSafety.call(runtime,{authority,context});check()
  for(const record of pageRecords){
   await bind(record);const tree=(await command(record,'Page.getFrameTree')).frameTree,frames=[],visit=(node,depth=0)=>{if(!node?.frame||depth>32||frames.length>=1000)throw fail('profile_live_document_changed');frames.push(node.frame);for(const child of node.childFrames||[])visit(child,depth+1)};visit(tree)
   for(const frame of frames){if(!id(frame.id)||!id(frame.loaderId))throw fail('profile_live_document_changed');const world=await command(record,'Page.createIsolatedWorld',{frameId:frame.id,worldName:'hoai-private-live-safety',grantUniveralAccess:false});if(!Number.isSafeInteger(world.executionContextId)||world.executionContextId<1)throw fail('profile_live_document_changed');const result=await command(record,'Runtime.evaluate',{expression:DOCUMENT_SAFETY_EXPRESSION,contextId:world.executionContextId,returnByValue:true});if(result.exceptionDetails||result.result?.value?.ready!==true||result.result.value.credentials!==false||result.result.value.unsaved!==false)throw fail('profile_live_credentials_protected')}
   if(!same(tree,(await command(record,'Page.getFrameTree')).frameTree))throw fail('profile_live_document_changed');await bind(record)
  }check()
 }
 const inventory=async record=>{
  await bind(record);const{databaseNames}=await command(record,'IndexedDB.requestDatabaseNames',{storageKey:record.storageKey});if(!Array.isArray(databaseNames)||databaseNames.length>100||new Set(databaseNames).size!==databaseNames.length||databaseNames.some(name=>typeof name!=='string'||name.length>1024))throw fail('profile_live_schema_unsupported')
  const databases=[];let total=0
  for(const name of [...databaseNames].sort()){
   const value=(await command(record,'IndexedDB.requestDatabase',{storageKey:record.storageKey,databaseName:name})).databaseWithObjectStores
   if(value?.name!==name||!Number.isSafeInteger(value.version)||value.version<1||!Array.isArray(value.objectStores)||value.objectStores.length>100||(total+=value.objectStores.length)>1000)throw fail('profile_live_schema_unsupported')
   const stores=[]
   for(const store of value.objectStores){if(typeof store.name!=='string'||store.name.length>1024||typeof store.autoIncrement!=='boolean')throw fail('profile_live_schema_unsupported');const metadata=await command(record,'IndexedDB.getMetadata',{storageKey:record.storageKey,databaseName:name,objectStoreName:store.name});if(!Number.isSafeInteger(metadata.entriesCount)||metadata.entriesCount<0||metadata.entriesCount>10000||store.autoIncrement&&(!Number.isSafeInteger(metadata.keyGeneratorValue)||metadata.keyGeneratorValue<1))throw fail('profile_live_generator_unsupported');stores.push({name:store.name,keyPath:keyPath(store.keyPath),autoIncrement:store.autoIncrement,entriesCount:metadata.entriesCount,...(store.autoIncrement?{nextKey:metadata.keyGeneratorValue}:{})})}
   databases.push({name,version:value.version,stores})
  }return databases
 }
 /** @template T @param {()=>T|Promise<T>} callback @returns {Promise<T>} */
 const run=callback=>{check();if(pending.size)throw fail('profile_live_read_busy');return track(async()=>{check();const value=await callback();check();return value})}
 const cap=Object.freeze({get origins(){return origins},assertCurrent:check,
  readCookies:()=>run(async()=>{const record=records.values().next().value;if(!record)throw fail('profile_live_origin_unavailable');await bind(record);return(await command(record,'Network.getAllCookies')).cookies}),
  readOrigin:origin=>run(async()=>{const record=records.get(origin);if(!record)throw fail('profile_live_origin_unavailable');const before=await inventory(record),world=await command(record,'Page.createIsolatedWorld',{frameId:record.frameId,worldName:'hoai-private-live-backup',grantUniveralAccess:false});if(!Number.isSafeInteger(world.executionContextId)||world.executionContextId<1)throw fail('profile_live_read_scope_invalid');const expression=`(${readLiveStorage.toString()})((${createStorageAdapter.toString()})().encode,JSON.parse(${JSON.stringify(JSON.stringify(before))}))`,result=await command(record,'Runtime.evaluate',{expression,contextId:world.executionContextId,awaitPromise:true,returnByValue:true});if(result.exceptionDetails||typeof result.result?.value!=='string'||Buffer.byteLength(result.result.value)>16*1024*1024||!same(before,await inventory(record)))throw fail('profile_live_storage_changed');return result.result.value}),
  verify:()=>run(safety),
  release:()=>{released=true;void cleanup().catch(()=>{})},
  whenDrained:async()=>{while(pending.size)await Promise.allSettled([...pending]);if(released)await cleanup();if(cleanupUnknown)throw fail('profile_live_cleanup_unknown')},
  activity:()=>Object.freeze({pendingPhysicalOperations:pending.size+(reservations.get(runtime)===token?1:0),cleanupUnknown})
 });reservations.set(runtime,token);leases.add(token)
 try{
  check()
  for(const [target,events]of [[context,['page']],...pages.map(page=>[page,['framenavigated','close','crash']])])for(const event of events){listeners.push([target,event]);sync(()=>target.on(event,changedListener))}
  await track(async()=>{
   check();const movable=await originalMovable.call(runtime);check();sync(()=>originalQualified.call(runtime,movable.origins));check();if(!Array.isArray(movable.origins)||movable.origins.length<1||movable.origins.length>100||new Set(movable.origins).size!==movable.origins.length)throw fail('profile_live_origin_unavailable');origins=Object.freeze([...movable.origins].sort())
   for(const origin of origins){let parsed;try{parsed=new URL(origin)}catch{throw fail('profile_live_origin_unavailable')}if(parsed.origin!==origin||!['http:','https:'].includes(parsed.protocol))throw fail('profile_live_origin_unavailable')}
   for(const page of pages){let origin;try{origin=new URL(page.url()).origin}catch{throw fail('profile_live_origin_unavailable')}if(!origins.includes(origin)||!runtime.pages.has(page)||page.mainFrame().url()!==page.url())throw fail('profile_live_origin_unavailable');const frame=page.mainFrame(),record={origin,page,frame,url:frame.url(),session:null,targetId:null,frameId:null,loaderId:null,storageKey:null};const session=await context.newCDPSession(page);sessions.push(session);record.session=session;pageRecords.push(record);if(!records.has(origin))records.set(origin,record);check();await bind(record)}
   if(origins.some(origin=>!records.has(origin)))throw fail('profile_live_origin_unavailable')
   await safety()
   generation=ledger.generation;check()
  });return cap
 }catch(error){released=true;await cap.whenDrained();throw error?.code?.startsWith('profile_live_')?error:fail('profile_live_capture_failed')}
}
