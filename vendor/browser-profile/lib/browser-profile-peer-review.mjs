import path from 'node:path'
import { createHash } from 'node:crypto'
import { AgentProfileCompanionState } from './browser-profile-companion-state.mjs'
import { AgentProfilePeerPins,peerReviewDocument } from './browser-profile-peer-pins.mjs'
import { AgentProfileCoordinatorClient } from './browser-profile-companion-client.mjs'
import { BrowserProfileSyncKeyStore } from './browser-profile-sync-key-store.mjs'
import { restoreProfileEnrollment,profileCrypto } from './browser-profile-runtime.mjs'
const fail=()=>Object.assign(new Error('profile_peer_pin_review_refused'),{code:'profile_peer_pin_review_refused'})
/** Explicit operator-only setup. This exports no credentials or authority. */
export async function reviewAgentProfilePeer({agentRoot,pairings,document,confirmation,environment=process.env,clientFactory=options=>new AgentProfileCoordinatorClient(options),keyStore=new BrowserProfileSyncKeyStore({endpointCrypto:profileCrypto,environment}),stateFactory=options=>new AgentProfileCompanionState(options),pinsFactory=options=>new AgentProfilePeerPins(options),assertPairingCurrent=()=>true}){
  if(!path.isAbsolute(agentRoot)||!Array.isArray(pairings)||typeof confirmation!=='string'||!/^[a-f0-9]{64}$/.test(confirmation))throw fail()
  document=peerReviewDocument(document);if(document.peerKeyFingerprint!==confirmation)throw fail()
  const matches=[]
  for(const pairing of pairings){
    if(!pairing.assistantIds.includes(document?.assistantId))continue
    const origin=new URL(pairing.backendUrl).origin,directory=path.join(agentRoot,'.browser-profile-sync',createHash('sha256').update(origin).digest('hex')),token=pairing.token,backendUrl=pairing.backendUrl,pairingId=pairing.pairingId,ownerUserId=pairing.ownerUserId,assistantIds=JSON.stringify(pairing.assistantIds)
    const check=()=>{if(!pairings.includes(pairing)||pairing.token!==token||pairing.backendUrl!==backendUrl||pairing.pairingId!==pairingId||pairing.ownerUserId!==ownerUserId||JSON.stringify(pairing.assistantIds)!==assistantIds||!pairing.assistantIds.includes(document.assistantId))throw fail();const current=assertPairingCurrent(pairing);if(current?.then){void Promise.resolve(current).catch(()=>{});throw fail()}if(current!==true)throw fail();return true}
    const store=stateFactory({directory:path.join(directory,'endpoints')});check();const rows=await store.loadAll(check);check()
    for(const row of rows){if(row.scope.profileId===document.profileId&&row.scope.actingUserId===document.actingUserId&&row.scope.assistantId===document.assistantId&&row.scope.endpointId===document.agentEndpointId&&row.scope.keyFingerprint===document.agentKeyFingerprint&&(!pairing.pairingId||pairing.pairingId===row.scope.pairingId))matches.push({pairing,origin,directory,row,check})}
  }
  if(matches.length!==1)throw fail();const{pairing,origin,directory,row,check}=matches[0]
  const client=clientFactory({endpoint:origin,authorizePairing:async()=>({token:pairing.token,assertCurrent:check})}),endpoint=await restoreProfileEnrollment({keyStore,record:row.keyRecord,pinnedIdentity:row.identity,pairing:{pairingId:row.scope.pairingId,ownerUserId:row.scope.ownerUserId},authorizeEnrollment:async()=>({...await client.enrollment(row.scope,row.identity),assertCurrent:check})})
  check();const discovery=await client.discover(row.scope,endpoint);check();if(discovery.profiles.length!==1||discovery.profiles[0].grant.backgroundUse!==true)throw fail()
  const result=await pinsFactory({directory:path.join(directory,'peer-pins',row.scope.endpointId)}).review({scope:row.scope,endpoint,document,confirmation,assertCurrent:check});check();return result
}
