// Owned Codex daemon child. Runtime and authorization come from the exact
// reviewed common host; pairing configuration arrives only over private IPC.
import path from 'node:path'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { BrowserHost,ChromiumEngine,createManagedProfileEngine,createManagedProfileRelay,DEFAULT_CAPS,servedBrowserTools,listTools,loadPlaywright,resolveChromeExecutable,pidAlive } from '../vendor/browser-profile/bin/hoai-browser-host.mjs'
import { ensureBrowser } from '../vendor/browser-profile/lib/browser-bootstrap.mjs'
import { AgentBrowserProfileCompanion } from '../vendor/browser-profile/lib/browser-profile-companion.mjs'
import { chromeEnv } from '../vendor/browser-profile/lib/browser-env.mjs'
import { terminateBrowserDaemon } from '../vendor/browser-profile/lib/browser-profile-daemon-stop.mjs'
import { configuration } from './browser-profile-configuration.mjs'
export { configuration } from './browser-profile-configuration.mjs'

const fail=()=>Object.assign(Error('browser_profile_configuration_invalid'),{code:'browser_profile_configuration_invalid'})
export function createHost({config:raw,environment=process.env,io,fetchImpl,log=()=>{},loadBrowser,createProfileRuntime}){
  const config=configuration(raw),agentRoot=config.directory,deviceLabel=`Codex on ${hostname()}`
  const catalog=new Map(config.assistantIds.map(id=>[path.join(agentRoot,`credentials-${id}.json`),JSON.stringify({backendUrl:config.backendUrl,pairingToken:config.pairingToken,pairingId:config.pairingId,assistantId:id})]))
  const browserEnvironment=chromeEnv(environment),load=loadBrowser||(async()=>({chromium:loadPlaywright().chromium,executable:await ensureBrowser({findInstalled:()=>environment.HOAI_BROWSER_EXECUTABLE?resolveChromeExecutable({env:environment}):{path:null},env:environment,log})}))
  const browserTools=async()=>servedBrowserTools(await listTools({caps:DEFAULT_CAPS,outputDir:path.join(agentRoot,'browser-host')}))
  const createEngine=async({profileDir,outputDir,heldDir,scope})=>new ChromiumEngine({executable:await ensureBrowser({findInstalled:()=>resolveChromeExecutable({env:browserEnvironment}),env:browserEnvironment,log}),profileDir,outputDir,heldDir,scope,headless:true,clientName:'hoai-codex-browser',log})
  const createProfileCompanion=(connection,legacyHost)=>new AgentBrowserProfileCompanion({connection,agentRoot,environment,deviceLabel,log,
    ...(createProfileRuntime?{createRuntime:createProfileRuntime}:{}),assertNoLegacyActive:scope=>!legacyHost.pool.peek({assistantId:scope.assistantId,principal:`user-${scope.actingUserId}`}),loadBrowser:load,
    createEngine:input=>createManagedProfileEngine({...input,log}),
    createRelay:core=>createManagedProfileRelay({core,deviceLabel,serverInfo:{name:'hoai-codex-profile',version:'1'},log}),
  })
  return new BrowserHost({agentRoot,env:{...environment,HOAI_BROWSER_HOST_AGENTS:config.assistantIds.join(',')},deviceLabel,browserTools,createEngine,createProfileCompanion,log,
    ...(io?{io}:{}),...(fetchImpl?{fetchImpl}:{}),listDir:directory=>directory===agentRoot?[...catalog.keys()].map(name=>path.basename(name)):[],readText:file=>catalog.get(file)??null,
    scope:{token:config.pairingToken,backendUrl:config.backendUrl,assistantId:null,parentPid:config.parentPid},
  })
}
export function activity(host){
  let activeProfiles=0,pendingWork=host.retiringConnections.size
  // This exact pinned host retains starts, drains and failed stops in _slots.
  // running() alone loses the physical stop after it clears slot.engine.
  if(host.pool?._slots instanceof Map)for(const slot of host.pool._slots.values()){
    if(slot.engine)activeProfiles++
    if(slot.starting||slot.stopping||slot.stopError)pendingWork++
  }
  else if(host.pool)pendingWork++
  for(const connection of new Set([...host.connections.values(),...host.retiringConnections.values()])){
    const companion=connection.profileCompanion;if(!companion)continue
    if(typeof companion.activity==='function'){
      const value=companion.activity()
      if(!value||!Number.isSafeInteger(value.activeProfiles)||value.activeProfiles<0||!Number.isSafeInteger(value.pendingPhysicalOperations)||value.pendingPhysicalOperations<0||typeof value.cleanupUnknown!=='boolean'){pendingWork++;continue}
      activeProfiles+=value.activeProfiles;pendingWork+=value.pendingPhysicalOperations+(value.cleanupUnknown?1:0)
    }else if(companion.records?.size||companion.pending||companion.candidates?.size)pendingWork++
  }
  return{activeProfiles:Math.min(4096,activeProfiles),pendingWork:Math.min(4096,pendingWork)}
}
export async function main({channel=process,environment=process.env,create=createHost,stopDeadlineMs=15000,stdin=process.stdin,signals=process}={}){
  if(!channel.send||!channel.connected)throw fail()
  let host,config,stopping=false,watch,initial,keepAlive
  const send=value=>{try{if(channel.connected)channel.send(value,()=>{})}catch{}}
  return new Promise(resolve=>{
    const cleanup=()=>{clearTimeout(initial);clearInterval(watch);clearInterval(keepAlive);channel.removeListener('message',message);channel.removeListener('disconnect',disconnected);stdin.removeListener('end',disconnected);stdin.removeListener('close',disconnected);stdin.removeListener('error',disconnected);signals.removeListener('SIGTERM',disconnected);signals.removeListener('SIGINT',disconnected)}
    const stop=async()=>{
      if(stopping)return;stopping=true;clearTimeout(initial);clearInterval(watch)
      let code=1
      try{code=host?await terminateBrowserDaemon({stop:()=>host.stop(),emergencyStop:()=>host.emergencyStopOwnedProfiles(),ms:stopDeadlineMs,log:()=>{}}):0}catch{}
      send({type:'browser-profile-stopped',code});cleanup();resolve(code)
    }
    const disconnected=()=>{void stop()}
    const message=frame=>{
      if(frame?.type==='browser-profile-stop'){void stop();return}
      if(frame?.type!=='browser-profile-configure'||stopping||config)return
      try{
        config=configuration(frame.configuration);if(config.parentPid!==process.ppid)throw fail()
        host=create({config,environment,log:()=>{}});host.start();clearTimeout(initial)
        keepAlive=setInterval(()=>{},60000)
        const status=()=>{if(stopping)return;try{if(!pidAlive(config.parentPid))return void stop();send({type:'browser-profile-state',...activity(host)})}catch{void stop()}}
        watch=setInterval(status,2000);watch.unref?.();status();send({type:'browser-profile-ready'})
      }catch{send({type:'browser-profile-refused',code:'browser_profile_configuration_invalid'});void stop()}
    }
    initial=setTimeout(()=>{send({type:'browser-profile-refused',code:'browser_profile_configuration_timeout'});void stop()},10000)
    channel.on('message',message);channel.once('disconnect',disconnected);stdin.once('end',disconnected);stdin.once('close',disconnected);stdin.once('error',disconnected);stdin.resume();signals.once('SIGTERM',disconnected);signals.once('SIGINT',disconnected)
  })
}
const isMain=()=>{try{return realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url))}catch{return false}}
if(isMain())main().then(code=>{process.exitCode=code;setTimeout(()=>process.exit(code),250).unref()}).catch(()=>{process.exitCode=1})
