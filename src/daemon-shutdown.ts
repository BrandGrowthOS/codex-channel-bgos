/** A failed guarded browser save is an unsuccessful daemon shutdown. */
export async function shutdownDaemon(stop:()=>Promise<void>,report:(code:string)=>void):Promise<0|1>{
  try{await stop();return 0}catch{report("daemon_cleanup_unconfirmed");return 1}
}
