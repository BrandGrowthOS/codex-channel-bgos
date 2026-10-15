import { constants, openSync, closeSync, fstatSync, readSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { BgosApi } from "./bgos-api.js";
import { loadConfig } from "./load-config.js";
import { configuration } from "../runtime/browser-profile-configuration.mjs";

const refused=()=>new Error("browser_profile_setup_refused");
export function readPublicPeerReview(file:string):unknown{
  if(!isAbsolute(file))throw refused();
  const before=lstatSync(file);if(!before.isFile()||before.isSymbolicLink())throw refused();
  const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let bytes:Buffer|undefined;
  try{
    const info=fstatSync(fd);if(!info.isFile()||info.dev!==before.dev||info.ino!==before.ino||info.size<1||info.size>8192)throw refused();
    bytes=Buffer.alloc(info.size+1);const length=readSync(fd,bytes,0,bytes.length,0),after=fstatSync(fd),pathname=lstatSync(file);
    if(length!==info.size||info.size!==after.size||info.mtimeMs!==after.mtimeMs||info.ctimeMs!==after.ctimeMs||!pathname.isFile()||pathname.isSymbolicLink()||pathname.dev!==info.dev||pathname.ino!==info.ino)throw refused();
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,length)));
  }finally{bytes?.fill(0);closeSync(fd)}
}
export async function checkBrowserPrerequisites():Promise<Readonly<Record<string,unknown>>>{
  const failure=(code:"browser_install_failed"|"browser_install_recovery_required")=>Object.assign(new Error(code),{code});
  let state:unknown;
  try{
    const module=await import(new URL("../vendor/browser-profile/lib/browser-bootstrap.mjs",import.meta.url).href),readiness=module.browserBootstrapReadiness();
    if(readiness?.then){void Promise.resolve(readiness).catch(()=>{});throw failure("browser_install_failed");}
    if(!readiness||typeof readiness!=="object"||Array.isArray(readiness))throw failure("browser_install_failed");
    state=readiness.state;
  }catch{throw failure("browser_install_failed");}
  if(state==="installing"||state==="recovery-required")throw failure("browser_install_recovery_required");
  if(state!=="installed"&&state!=="needs-install")throw failure("browser_install_failed");
  return Object.freeze({
    managedAgentPlatform:process.platform==="linux"?"supported-with-prerequisites":"linux-agent-required",
    browser:state==="installed"?"bundled-cache-present":"automatic-first-use-download",
    keyService:"requires-unlocked-persistent-Secret-Service-and-/usr/bin/gdbus-and-/usr/bin/secret-tool",
    keyServiceAvailability:"not-probed-without-an-enrolled-profile",sandbox:"required",authorization:"device-review-background-grant-and-session-confirmation-required",
  });
}
export async function reviewBrowserPeer(file:string,confirmation:string):Promise<void>{
  if(!/^[a-f0-9]{64}$/.test(confirmation))throw refused();
  const document=readPublicPeerReview(file),cfg=loadConfig(),api=new BgosApi(cfg),me=await api.whoami();
  const home=process.env.CODEX_BGOS_HOME?.trim(),directory=join(home?(home.startsWith("~")?join(homedir(),home.slice(1)):home):join(homedir(),".codex-bgos"),"browser");
  const config=configuration({backendUrl:cfg.baseUrl,pairingToken:cfg.pairingToken,pairingId:me.pairing_id,ownerUserId:me.user_id,assistantIds:(me.assistants??[]).filter(a=>a.agent_route).map(a=>a.assistant_id),directory,parentPid:process.pid});
  const pairing={backendUrl:config.backendUrl,token:config.pairingToken,pairingId:config.pairingId,ownerUserId:config.ownerUserId,assistantIds:config.assistantIds},pairings=[pairing];
  const module=await import(new URL("../vendor/browser-profile/lib/browser-profile-peer-review.mjs",import.meta.url).href);
  await module.reviewAgentProfilePeer({agentRoot:directory,pairings,document,confirmation,environment:process.env,assertPairingCurrent:()=>{const now=loadConfig();return now.baseUrl===cfg.baseUrl&&now.pairingToken===cfg.pairingToken}});
}
