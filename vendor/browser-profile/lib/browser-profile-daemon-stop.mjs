/** Explicit process termination only. A normal browser-close refusal must not
 * enter this helper. No write is retried and no stopped receipt is fabricated. */
export async function terminateBrowserDaemon({stop,emergencyStop,ms=12000,cleanupMs=6000,log=/** @type {(line:string)=>void} */(()=>{})}){
  if(typeof stop!=='function'||typeof emergencyStop!=='function'||!Number.isSafeInteger(ms)||ms<1||ms>120000||!Number.isSafeInteger(cleanupMs)||cleanupMs<1||cleanupMs>30000)throw Error('profile_daemon_shutdown_invalid')
  const bounded=async(work,budget)=>{let timer;try{return await Promise.race([Promise.resolve().then(work).then(value=>({done:true,value}),()=>({done:false})),new Promise(resolve=>{timer=setTimeout(()=>resolve({done:false}),budget)})])}finally{clearTimeout(timer)}}
  const ordinary=await bounded(stop,ms)
  if(ordinary.done){log('stopped cleanly');return 0}
  log('recovery_required: guarded browser save did not complete; no stopped checkpoint or failover is confirmed')
  const cleanup=await bounded(emergencyStop,cleanupMs)
  if(cleanup.done&&cleanup.value?.stopped===true)log('owned native processes stopped; prior encrypted journal retained for explicit recovery')
  else log('recovery_required: owned native process cleanup is unconfirmed')
  return 1
}
