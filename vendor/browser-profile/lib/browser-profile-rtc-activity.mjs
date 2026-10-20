import { randomUUID } from 'node:crypto'

// Agent/main only. Each exact native version is qualified before website code.
export const RTC_BROWSER_VERSION = '156.0.8078.4'
export const RTC_BROWSER_VERSIONS = Object.freeze([RTC_BROWSER_VERSION])
export const RTC_MAX_HISTORY = 4096
const URL = 'chrome://webrtc-internals/', API = '__hoaiPrivateRtc', BINDING = '__hoaiPrivateRtcSignal'
const fail = code => Object.assign(new Error(code), { code, reason: code })
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
const FIELDS = ['profileId','actingUserId','assistantId','endpointId','bootId','runtimeId','sessionId','writerEpoch','revision','contentKeyEpoch','grantVersion','keyFingerprint']
function authorityOf(value) {
  if (!value || Object.keys(value).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(value,key)) ||
      ['profileId','actingUserId','endpointId','bootId','runtimeId','sessionId'].some(key=>!id(value[key])) ||
      ['assistantId','writerEpoch','contentKeyEpoch','grantVersion'].some(key=>!Number.isSafeInteger(value[key])||value[key]<1) ||
      !Number.isSafeInteger(value.revision)||value.revision<0||!/^[a-f0-9]{64}$/.test(value.keyFingerprint)) throw fail('profile_rtc_authority_invalid')
  return Object.freeze(Object.fromEntries(FIELDS.map(key=>[key,value[key]])))
}
export function chromiumRtcScript(token) {
  return `(()=>{
    const token=${JSON.stringify(token)},maximum=${RTC_MAX_HISTORY},seen=new Set();let wrapped,installed=false,failed=false,used=false,controlRid=null,pending=null,started=false;
    const valid=value=>Number.isSafeInteger(value)&&value>0,status=()=>({installed,failed,used,controlReady:controlRid!==null});
    const signal=()=>globalThis.${BINDING}(JSON.stringify({token,failed,used})),poison=()=>{failed=true;signal()};
    const inspect=value=>{if(!value||!valid(value.rid)||!valid(value.lid)){poison();return false}if(!seen.has(value.rid)&&seen.size>=maximum){poison();return false}seen.add(value.rid);return true};
    const dispatch=(event,data)=>{
      if(event==='add-peer-connection'&&inspect(data)){
        if(controlRid===null){if(!pending||!pending.startup){poison();return}controlRid=data.rid}
        else if(data.rid!==controlRid){used=true;signal()}
        if(pending&&data.rid===controlRid){const done=pending.resolve;pending=null;done(status())}
      }else if(event==='update-all-peer-connections'){
        if(!Array.isArray(data)||data.length>maximum){poison();return}
        for(const value of data){if(!inspect(value))return;if(controlRid===null){poison();return}if(value.rid!==controlRid){used=true;signal()}}
      }
      // Never forward native peer URL, SDP, media or stats into the stock model.
    };
    Object.defineProperty(globalThis,'cr',{configurable:false,get:()=>wrapped,set:value=>{if(installed||!value||typeof value.webUIResponse!=='function'||typeof value.webUIListenerCallback!=='function')throw Error('profile_rtc_filter_refused');wrapped=Object.freeze({webUIResponse:value.webUIResponse,webUIListenerCallback:dispatch});installed=true}});
    const marker=startup=>{if(!installed||pending||startup===started)throw Error('profile_rtc_marker_refused');if(startup)started=true;return new Promise(resolve=>{pending={resolve,startup};const peer=new RTCPeerConnection({iceServers:[]});peer.close()})};
    Object.defineProperty(globalThis,'${API}',{value:Object.freeze({start:()=>marker(true),flush:()=>marker(false),status})});
  })()`
}

export class ChromiumRtcActivity {
  constructor({ browser, root, authority, browserVersion, processIdentity, timeoutMs=5000 }) {
    if (!browser?.newContext||!browser.contexts||!browser.isConnected||!root?.send||!root.on||!root.removeListener||!RTC_BROWSER_VERSIONS.includes(browserVersion)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000 ||
        !Number.isSafeInteger(processIdentity?.pid)||processIdentity.pid<1||typeof processIdentity.started!=='string'||!/^\d{1,32}$/.test(processIdentity.started)) throw fail('profile_rtc_native_version_unqualified')
    Object.assign(this,{browser,root,browserVersion,timeoutMs});this.authority=authorityOf(authority);this.processIdentity=Object.freeze({...processIdentity});this.kind='qualified-chromium-native-observer-v1';this.token=randomUUID();this.history=new Map();this.contexts=new Set();this.listeners=[];this.pending=0;this.used=false;this.failure=null;this.ready=false;this.disposed=false
    this.targetCreated=({targetInfo})=>{try{this._record(targetInfo)}catch{this._poison('profile_rtc_inventory_unqualified')}}
    this.targetDestroyed=({targetId})=>{const value=this.history.get(targetId);if(value)value.destroyed=true;if(targetId===this.privateTargetId&&!this.disposed)this._poison('profile_rtc_observer_lost')}
    this.disconnected=()=>{if(!this.disposed)this._poison('profile_rtc_observer_lost')}
  }
  _poison(code){this.failure ||= code}
  _alive(){if(this.disposed||!this.browser.isConnected())throw fail('profile_rtc_observer_lost');if(this.failure)throw fail(this.failure)}
  async _bounded(work){this._alive();if(this.pending>=16)throw fail('profile_rtc_callback_limit');this.pending++;let timer;const physical=Promise.resolve().then(work);void physical.finally(()=>this.pending--).catch(()=>{});try{return await Promise.race([physical,new Promise((_r,reject)=>{timer=setTimeout(()=>{this._poison('profile_rtc_callback_timeout');reject(fail('profile_rtc_callback_timeout'))},this.timeoutMs)})])}finally{clearTimeout(timer)}}
  async _send(method,params={}){return this._bounded(()=>this.root.send(method,params))}
  _record(info){if(!info||!id(info.targetId)||!id(info.browserContextId)||!['page','iframe','worker','shared_worker','service_worker'].includes(info.type))throw fail('profile_rtc_inventory_unqualified');if(!this.history.has(info.targetId)&&this.history.size>=RTC_MAX_HISTORY)throw fail('profile_rtc_inventory_limit');this.history.set(info.targetId,{targetId:info.targetId,contextId:info.browserContextId,type:info.type,destroyed:false});if(this.ready&&this.privateContextId&&info.browserContextId===this.privateContextId&&info.targetId!==this.privateTargetId)this._poison('profile_rtc_inventory_unqualified');if(this.ownedContextId&&![this.privateContextId,this.ownedContextId].includes(info.browserContextId))this._poison('profile_rtc_inventory_unqualified')}
  async _inventory({binding=false}={}){
    this._alive();const nativeContexts=(await this._send('Target.getBrowserContexts')).browserContextIds,targets=(await this._send('Target.getTargets')).targetInfos,processes=(await this._send('SystemInfo.getProcessInfo')).processInfo
    if(!Array.isArray(nativeContexts)||nativeContexts.length>2||nativeContexts.some(value=>!id(value))||!Array.isArray(targets)||targets.length>RTC_MAX_HISTORY||!Array.isArray(processes)||processes.length>RTC_MAX_HISTORY||processes.filter(value=>value.type==='browser').length!==1||processes.find(value=>value.type==='browser')?.id!==this.processIdentity.pid)throw fail('profile_rtc_inventory_unqualified')
    const allowed=[this.privateContextId,...(this.ownedContextId?[this.ownedContextId]:[])].filter(Boolean)
    if(nativeContexts.length!==allowed.length||nativeContexts.some(value=>!allowed.includes(value))||this.browser.contexts().length!==allowed.length||!this.browser.contexts().includes(this.privateContext)||this.ownedContext&&!this.browser.contexts().includes(this.ownedContext))throw fail('profile_rtc_inventory_unqualified')
    for(const info of targets)this._record(info)
    for(const record of this.history.values())if(!allowed.includes(record.contextId)||record.contextId===this.privateContextId&&record.targetId!==this.privateTargetId||binding&&record.contextId===this.ownedContextId)throw fail('profile_rtc_inventory_unqualified')
    const own=targets.filter(value=>value.browserContextId===this.ownedContextId),privateTargets=targets.filter(value=>value.browserContextId===this.privateContextId)
    if(privateTargets.length!==1||privateTargets[0].targetId!==this.privateTargetId||privateTargets[0].type!=='page'||privateTargets[0].url!==URL||this.privatePage.isClosed()||this.privatePage.url()!==URL)throw fail('profile_rtc_observer_lost')
    this._alive();return own
  }
  _native(method,params){
    if(this.disposed)return
    if(method==='Runtime.executionContextsCleared'){this.contexts.clear();if(this.ready)this._poison('profile_rtc_observer_lost');return}
    if(method==='Runtime.executionContextCreated'){const c=params?.context;if(c?.origin==='chrome://webrtc-internals'&&c.auxData?.isDefault===true&&Number.isSafeInteger(c.id))this.contexts.add(c.id);return}
    if(method==='Runtime.executionContextDestroyed'){if(this.contexts.delete(params?.executionContextId)&&this.ready)this._poison('profile_rtc_observer_lost');return}
    if(method!=='Runtime.bindingCalled')return
    try{if(params?.name!==BINDING||!this.contexts.has(params.executionContextId)||typeof params.payload!=='string'||Buffer.byteLength(params.payload)>256)throw Error();const value=JSON.parse(params.payload);if(!value||Object.keys(value).length!==3||value.token!==this.token||typeof value.used!=='boolean'||typeof value.failed!=='boolean')throw Error();this.used ||= value.used;if(value.failed)this._poison('profile_rtc_history_unqualified')}catch{this._poison('profile_rtc_protocol_unqualified')}
  }
  _status(value){if(!value||Object.keys(value).length!==4||value.installed!==true||value.controlReady!==true||typeof value.used!=='boolean'||typeof value.failed!=='boolean')throw fail('profile_rtc_observer_lost');this.used ||= value.used;if(value.failed)this._poison('profile_rtc_history_unqualified');this._alive()}
  async start(){
    try{
      if(await this.browser.version()!==this.browserVersion||this.browser.contexts().length||(await this._send('Target.getBrowserContexts')).browserContextIds.length||(await this._send('Target.getTargets')).targetInfos.length)throw fail('profile_rtc_exclusive_browser_required')
      this.root.on('Target.targetCreated',this.targetCreated);this.root.on('Target.targetDestroyed',this.targetDestroyed);this.browser.on('disconnected',this.disconnected);await this._send('Target.setDiscoverTargets',{discover:true})
      this.privateContext=await this._bounded(()=>this.browser.newContext({serviceWorkers:'block',acceptDownloads:false}));this.privatePage=await this._bounded(()=>this.privateContext.newPage());this.cdp=await this._bounded(()=>this.privateContext.newCDPSession(this.privatePage));this.privateClose=()=>{if(!this.disposed)this._poison('profile_rtc_observer_lost')};this.privatePage.on('close',this.privateClose)
      this.nativeListeners=['Runtime.executionContextsCleared','Runtime.executionContextCreated','Runtime.executionContextDestroyed','Runtime.bindingCalled'].map(method=>{const listener=value=>this._native(method,value);this.cdp.on(method,listener);return[method,listener]})
      await this._bounded(()=>this.cdp.send('Page.enable'));await this._bounded(()=>this.cdp.send('Runtime.enable'));await this._bounded(()=>this.cdp.send('Runtime.addBinding',{name:BINDING}));await this._bounded(()=>this.cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:chromiumRtcScript(this.token)}));await this._bounded(()=>this.privatePage.goto(URL))
      const info=(await this._bounded(()=>this.cdp.send('Target.getTargetInfo'))).targetInfo;if(!id(info?.targetId)||!id(info.browserContextId)||info.type!=='page'||info.url!==URL||!this.contexts.size)throw fail('profile_rtc_observer_lost');this.privateContextId=info.browserContextId;this.privateTargetId=info.targetId
      await this._inventory();this._status(await this._bounded(()=>this.privatePage.evaluate(()=>globalThis.__hoaiPrivateRtc.start())));await this._inventory();this.ready=true;return this
    }catch(error){await this.dispose().catch(()=>{});throw error}
  }
  async bindContext({context,contextId}){
    this._alive();if(!this.ready||this.ownedContext||!context||context===this.privateContext||!id(contextId)||contextId===this.privateContextId)throw fail('profile_rtc_scope_unqualified')
    this.ownedContext=context;this.ownedContextId=contextId;try{await this._inventory({binding:true})}catch(error){this._poison('profile_rtc_scope_unqualified');throw error}
  }
  _scope({authority,context,browserVersion}){this._alive();const current=authorityOf(authority);if(!this.ready||!this.ownedContext||context!==this.ownedContext||browserVersion!==this.browserVersion||FIELDS.some(key=>current[key]!==this.authority[key]))throw fail('profile_rtc_scope_unqualified')}
  assertQualified(value){this._scope(value);if(this.used)throw fail('profile_rtc_history_unqualified');return true}
  async confirmStopped(value){
    this._scope(value);if(typeof value.assertPhysicalZero!=='function')throw fail('profile_rtc_scope_unqualified')
    const zero=async()=>{if(await value.assertPhysicalZero()!==true||(await this._inventory()).length)throw fail('profile_rtc_stop_unconfirmed');this._scope(value)}
    await zero();this._status(await this._bounded(()=>this.privatePage.evaluate(()=>globalThis.__hoaiPrivateRtc.flush())));await zero();return this.assertQualified(value)
  }
  dispose(){if(!this.disposal)this.disposal=this._dispose();return this.disposal}
  async _dispose(){
    this.disposed=true;this.root.removeListener('Target.targetCreated',this.targetCreated);this.root.removeListener('Target.targetDestroyed',this.targetDestroyed);this.browser.removeListener('disconnected',this.disconnected);for(const[method,listener]of this.nativeListeners||[])this.cdp.removeListener(method,listener);this.privatePage?.removeListener('close',this.privateClose)
    if(!this.privateContext||!this.browser.isConnected())return
    let timer;try{const work=(async()=>{await this.privateContext.close();if(!this.privatePage.isClosed()||(await this.root.send('Target.getTargets')).targetInfos.some(info=>info.browserContextId===this.privateContextId)||this.browser.contexts().includes(this.privateContext))throw fail('profile_rtc_disposal_unconfirmed')})();void work.catch(()=>{});await Promise.race([work,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(fail('profile_rtc_disposal_unconfirmed')),this.timeoutMs)})])}finally{clearTimeout(timer)}
  }
}
export async function createChromiumRtcActivity(options){return new ChromiumRtcActivity(options).start()}
