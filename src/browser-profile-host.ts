import { fork as nodeFork, type ChildProcess, type ForkOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { configuration, type BrowserProfileConfiguration } from "../runtime/browser-profile-configuration.mjs";

interface HostEnvironment { hostEnv(env: NodeJS.ProcessEnv): Record<string,string> }
type ChildState="starting"|"running"|"stopping"|"stopped"|"recovery-required";
interface OwnedChild {
  config: Readonly<BrowserProfileConfiguration>; hash:string; child:ChildProcess; state:ChildState;
  activeProfiles:number|null; pendingWork:number|null; stopping:boolean; stoppedReceipt:boolean;
  exitCode:number|null; exited:boolean; physical:Promise<void>; resolveExit:()=>void;
  receipt:Promise<void>; resolveReceipt:()=>void; stopWork?:Promise<void>;
  uncertain:boolean;
}
const fail=()=>Object.assign(new Error("browser_profile_cleanup_unconfirmed"),{code:"browser_profile_cleanup_unconfirmed"});
const fingerprint=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

// One exact owned child. Process exit alone is not a clean browser receipt.
// A timeout retains the record and can never authorize an automatic restart.
export class BrowserProfileHost {
  private record:OwnedChild|null=null;
  private tail:Promise<unknown>=Promise.resolve();
  private closed=false;
  private generation=0;
  private queued=0;
  constructor(private readonly options:{
    environment?:NodeJS.ProcessEnv; entry?:string; platform?:NodeJS.Platform;
    spawn?:(entry:string,args:string[],options:ForkOptions)=>ChildProcess;
    hostEnvironment?:HostEnvironment; stopTimeoutMs?:number; log?:(code:string)=>void;
    onState?:(status:ReturnType<BrowserProfileHost["status"]>)=>void;
  }={}){}
  get busy():boolean {if(this.queued>0)return true;const row=this.record;return Boolean(row&&(row.state!=="running"||row.activeProfiles===null||row.pendingWork===null||row.activeProfiles>0||row.pendingWork>0)&&row.state!=="stopped")}
  status(){const row=this.record,stopped=row?.state==="stopped";return Object.freeze({state:row?.state??"idle",busy:this.busy,activeProfiles:stopped?0:row?.activeProfiles??null,pendingWork:stopped?0:row?.pendingWork??null})}
  private changed(){try{this.options.onState?.(this.status())}catch{}}
  private async environment(){
    const supplied=this.options.hostEnvironment??await import(new URL("../vendor/browser-profile/lib/browser-env.mjs",import.meta.url).href) as HostEnvironment;
    return supplied.hostEnv(this.options.environment??process.env);
  }
  synchronize(raw:unknown):Promise<ReturnType<BrowserProfileHost["status"]>>{
    const config=configuration(raw),generation=this.generation;
    const current=()=>{if(this.closed||this.generation!==generation)throw fail()};
    this.queued++;this.changed();
    const work=this.tail.catch(()=>{}).then(async()=>{
      current();const hash=fingerprint(config);
      if(this.record?.hash===hash&&this.record.state!=="stopped")return this.status();
      if(this.record)await this.stopRecord(this.record);
      current();
      const env=await this.environment();current();
      const entry=this.options.entry??fileURLToPath(new URL("../runtime/browser-profile-host.mjs",import.meta.url));
      const forkOptions:ForkOptions & {windowsHide:boolean}={env,stdio:["pipe","ignore","pipe","ipc"],windowsHide:true,serialization:"json",execArgv:[]};
      current();const child=(this.options.spawn??nodeFork)(entry,[],forkOptions);
      let resolveExit=()=>{};const physical=new Promise<void>(resolve=>{resolveExit=resolve});
      let resolveReceipt=()=>{};const receipt=new Promise<void>(resolve=>{resolveReceipt=resolve});
      const row:OwnedChild={config,hash,child,state:"starting",activeProfiles:null,pendingWork:null,stopping:false,stoppedReceipt:false,exitCode:null,exited:false,physical,resolveExit,receipt,resolveReceipt,uncertain:false};this.record=row;
      child.stderr?.on("data",chunk=>{if(Buffer.isBuffer(chunk))chunk.fill(0)});
      child.on("message",frame=>{
        if(this.record!==row||!frame||typeof frame!=="object")return;const value=frame as Record<string,unknown>;
        if(value.type==="browser-profile-ready"&&!row.stopping&&row.state==="starting")row.state="running";
        else if(value.type==="browser-profile-state"&&!row.stopping&&["starting","running"].includes(row.state)&&Number.isSafeInteger(value.activeProfiles)&&Number(value.activeProfiles)>=0&&Number(value.activeProfiles)<=4096&&Number.isSafeInteger(value.pendingWork)&&Number(value.pendingWork)>=0&&Number(value.pendingWork)<=4096){row.activeProfiles=Number(value.activeProfiles);row.pendingWork=Number(value.pendingWork)}
        else if(value.type==="browser-profile-stopped"&&row.stopping&&value.code===0){row.stoppedReceipt=true;row.resolveReceipt();if(row.exited&&row.exitCode===0&&!row.uncertain)row.state="stopped"}
        else if(value.type==="browser-profile-refused")row.state="recovery-required";
        this.changed();
      });
      child.once("error",()=>{row.state="recovery-required";this.options.log?.("browser_profile_start_unconfirmed");this.changed()});
      child.once("exit",code=>{row.exited=true;row.exitCode=code;row.state=!row.uncertain&&row.stopping&&code===0?(row.stoppedReceipt?"stopped":"stopping"):"recovery-required";row.resolveExit();this.changed()});
      if(this.closed||this.generation!==generation){await this.stopRecord(row);throw fail()}
      try{child.send({type:"browser-profile-configure",configuration:config},error=>{if(error){row.state="recovery-required";this.options.log?.("browser_profile_configuration_unconfirmed");this.changed()}})}catch{row.state="recovery-required"}
      return this.status();
    }).finally(()=>{this.queued--;this.changed()});this.tail=work;return work;
  }
  private stopRecord(row:OwnedChild):Promise<void>{
    if(row.stopWork)return row.stopWork;
    const exitedBeforeRequest=row.exited&&!row.stopping;
    row.stopping=true;if(!row.exited)row.state="stopping";this.changed();
    const work=(async()=>{
      if(!row.exited){try{row.child.send({type:"browser-profile-stop"},()=>{})}catch{}try{row.child.stdin?.end()}catch{}}
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{if(exitedBeforeRequest)throw fail();await Promise.race([Promise.all([row.physical.then(()=>{if(row.exitCode!==0)throw fail()}),row.receipt]),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(fail()),this.options.stopTimeoutMs??25000)})]);
        if(!row.stoppedReceipt||row.exitCode!==0)throw fail();row.state="stopped";
      }catch(error){row.uncertain=true;row.state="recovery-required";throw error}finally{if(timer)clearTimeout(timer);this.changed()}
    })();row.stopWork=work;void work.catch(()=>{});return work;
  }
  revoke():Promise<void>{this.generation++;const row=this.record;return row?this.stopRecord(row):Promise.resolve()}
  async stop():Promise<void>{this.closed=true;this.generation++;const row=this.record;const stopped=row?this.stopRecord(row):null;await this.tail.catch(()=>{});if(stopped)await stopped;else if(this.record)await this.stopRecord(this.record)}
}
