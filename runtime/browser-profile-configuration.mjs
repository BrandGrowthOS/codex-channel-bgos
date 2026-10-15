import path from 'node:path'
const fail=()=>Object.assign(Error('browser_profile_configuration_invalid'),{code:'browser_profile_configuration_invalid'})
export function configuration(raw){
  const fields=['backendUrl','pairingToken','pairingId','ownerUserId','assistantIds','directory','parentPid']
  if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).length!==fields.length)throw fail()
  const data=Object.getOwnPropertyDescriptors(raw)
  if(fields.some(key=>!data[key]?.enumerable||!Object.hasOwn(data[key],'value')))throw fail()
  const ids=raw.assistantIds
  if(!Array.isArray(ids)||Object.getPrototypeOf(ids)!==Array.prototype||ids.length<1||ids.length>100||Reflect.ownKeys(ids).length!==ids.length+1)throw fail()
  const entries=Object.getOwnPropertyDescriptors(ids),assistantIds=[]
  for(let index=0;index<ids.length;index++){const item=entries[index];if(!item?.enumerable||!Object.hasOwn(item,'value')||!Number.isSafeInteger(item.value)||item.value<1)throw fail();assistantIds.push(item.value)}
  if(new Set(assistantIds).size!==assistantIds.length)throw fail()
  if(typeof raw.backendUrl!=='string'||raw.backendUrl.length>2048||typeof raw.pairingToken!=='string'||raw.pairingToken.length<20||raw.pairingToken.length>4096||/\s/.test(raw.pairingToken)||
    !Number.isSafeInteger(raw.pairingId)||raw.pairingId<1||typeof raw.ownerUserId!=='string'||!/^user_[A-Za-z0-9_-]{1,190}$/.test(raw.ownerUserId)||
    typeof raw.directory!=='string'||raw.directory.length>4096||raw.directory.includes('\0')||!path.isAbsolute(raw.directory)||!Number.isSafeInteger(raw.parentPid)||raw.parentPid<1)throw fail()
  let url;try{url=new URL(raw.backendUrl)}catch{throw fail()}
  if(url.origin!==raw.backendUrl||url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))throw fail()
  return Object.freeze({...raw,assistantIds:Object.freeze(assistantIds.sort((a,b)=>a-b))})
}
