import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapter.js";

const token="SYNTHETIC_PAIRING_TOKEN_0123456789",origin="http://127.0.0.1:12345";
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve))};
const homes:string[]=[],adapters:any[]=[];
class Child extends EventEmitter{frames:any[]=[];stdin=new PassThrough();stderr=new PassThrough();send(value:any,done:()=>void){this.frames.push(value);done();return true}stop(){this.emit("message",{type:"browser-profile-stopped",code:0});this.emit("exit",0,null)}}
function fixture(){
  const home=mkdtempSync(join(tmpdir(),"hoai-codex-profile-adapter-"));homes.push(home);vi.stubEnv("CODEX_BGOS_HOME",home);vi.stubEnv("HOAI_HOME",home);
  const a=new CodexAdapter({baseUrl:origin,pairingToken:token,reconnect:{initialDelayMs:1,maxDelayMs:2}},{ok:true,mode:"chatgpt",label:"synthetic auth"},{agents:[],commandSeedMode:"never"}) as any;adapters.push(a);
  const children:Child[]=[];a.browserProfiles.options.spawn=()=>{const child=new Child();children.push(child);return child};a.started=true;
  a.api.whoami=vi.fn(async()=>({pairing_id:8,user_id:"user_recipient",assistants:[{assistant_id:42,agent_route:"codex",name:"Synthetic",command_count:1}]}));
  a.startSecretsWatch=vi.fn();a.reportStoredSessionSettings=vi.fn(async()=>{});a.ws.connect=vi.fn(async()=>{});a.ws.triggerBackfill=vi.fn(async()=>{});a.ws.disconnect=vi.fn();a.api.updateToken=vi.fn();a.ws.updateToken=vi.fn();a.outbound.replaySpool=vi.fn(async()=>{});a.startPollLoop=vi.fn();
  return{a,home,children};
}
afterEach(async()=>{
  for(const a of adapters){a.browserProfiles.record?.child.stop();await a.stop().catch(()=>{})}adapters.length=0;
  vi.unstubAllEnvs();for(const home of homes)rmSync(home,{recursive:true,force:true});homes.length=0;
});
describe("managed browser authorization in the real Codex adapter",()=>{
  it("starts the common child only after exact identity and keeps browser work busy in the real heartbeat",async()=>{
    const {a,home,children}=fixture();expect(children).toHaveLength(0);expect(await a.refreshIdentity()).toBe(true);expect(children).toHaveLength(1);
    expect(children[0].frames[0]).toEqual({type:"browser-profile-configure",configuration:{backendUrl:origin,pairingToken:token,pairingId:8,ownerUserId:"user_recipient",assistantIds:[42],directory:join(home,"browser"),parentPid:process.pid}});
    const child=children[0];child.emit("message",{type:"browser-profile-ready"});child.emit("message",{type:"browser-profile-state",activeProfiles:1,pendingWork:0});
    expect(a.isAnyBusy()).toBe(true);expect(await a.backgroundJobCount()).toBe(1);
    a.host.queues.set(8,Promise.resolve());a.host.queues.delete(8);expect(JSON.parse(readFileSync(join(home,"bgos_heartbeat.json"),"utf8")).busy).toBe(true);
    child.emit("message",{type:"browser-profile-state",activeProfiles:0,pendingWork:0});expect(a.isAnyBusy()).toBe(false);expect(await a.backgroundJobCount()).toBe(0);
    expect(JSON.parse(readFileSync(join(home,"bgos_heartbeat.json"),"utf8")).busy).toBe(false);
    const stop=a.stop();await tick();child.stop();await stop;
  });
  it("revokes before a stale whoami response can configure the old pairing",async()=>{
    const {a,children}=fixture();let release!:(value:any)=>void;a.api.whoami=vi.fn(()=>new Promise(resolve=>{release=resolve}));
    const reading=a.refreshIdentity();a.enterFatalLatch("revoked","synthetic revoked");release({pairing_id:8,user_id:"user_recipient",assistants:[{assistant_id:42,agent_route:"codex"}]});
    expect(await reading).toBe(false);expect(children).toHaveLength(0);expect(a.ownerId).toBe("");
  });
  it("re-pairs only after positive old cleanup and uses the new origin for both browser paths",async()=>{
    const {a,children}=fixture();await a.refreshIdentity();a.enterFatalLatch("rotated","synthetic rotation");
    a.api.whoami=vi.fn(async()=>({pairing_id:9,user_id:"user_recipient",assistants:[{assistant_id:43,agent_route:"codex",command_count:1}]}));
    const replacement="SYNTHETIC_REPLACEMENT_TOKEN_0123456789",newOrigin="http://127.0.0.1:12346";
    const recovering=a.recover(replacement,newOrigin);await tick();expect(a.currentToken).toBe(token);expect(a.api.updateToken).not.toHaveBeenCalled();expect(children).toHaveLength(1);
    children[0].stop();await recovering;expect(children).toHaveLength(2);expect(children[1].frames[0].configuration).toMatchObject({pairingId:9,pairingToken:replacement,backendUrl:newOrigin,assistantIds:[43]});expect(a.browserRelay(100)).toMatchObject({backendUrl:newOrigin,pairingToken:replacement,assistantId:43});
    const stop=a.stop();await tick();children[1].stop();await stop;
  });
  it("keeps re-pair latched when old cleanup cannot be proved",async()=>{
    const {a,children}=fixture();a.browserProfiles.options.stopTimeoutMs=5;await a.refreshIdentity();a.enterFatalLatch("rotated","synthetic rotation");await new Promise(resolve=>setTimeout(resolve,15));
    await a.recover("SYNTHETIC_REPLACEMENT_TOKEN_0123456789","http://127.0.0.1:12346");expect(a.currentToken).toBe(token);expect(a.fatalLatched).toBe(true);expect(a.api.updateToken).not.toHaveBeenCalled();expect(children).toHaveLength(1);await expect(a.stop()).rejects.toThrow("browser_profile_cleanup_unconfirmed");
  });
  it("releases the child when the verified catalog becomes empty",async()=>{
    const {a,children}=fixture();await a.refreshIdentity();a.api.whoami=vi.fn(async()=>({pairing_id:8,user_id:"user_recipient",assistants:[]}));
    const refreshing=a.refreshIdentity();await tick();expect(children[0].frames.at(-1)).toEqual({type:"browser-profile-stop"});children[0].stop();expect(await refreshing).toBe(true);expect(children).toHaveLength(1);expect(a.assistantToRoute.size).toBe(0);
  });
  it("the real registered bind and unbind handlers replace only after the prior child physically stops",async()=>{
    const {a,children}=fixture(),handlers=new Map<string,(value:any)=>void>();a.started=false;
    a.ws.on=(name:string,handler:(value:any)=>void)=>handlers.set(name,handler);a.host.preflight=vi.fn(async()=>{});a.heartbeat.start=vi.fn();a.loadServedCapabilities=vi.fn(async()=>{});a.sweepOrphanedApprovals=vi.fn(async()=>{});a.reportStoredPlanModes=vi.fn(async()=>{});a.sweepMissedPlanAnswers=vi.fn(async()=>{});a.seedDefaultCommands=vi.fn(async()=>{});
    await a.start();expect(children).toHaveLength(1);handlers.get("assistant_bound")!({assistantId:43,agentRoute:"codex-two"});await tick();expect(children).toHaveLength(1);expect(children[0].frames.at(-1)).toEqual({type:"browser-profile-stop"});
    children[0].stop();await tick();expect(children).toHaveLength(2);expect(children[1].frames[0].configuration.assistantIds).toEqual([42,43]);
    handlers.get("assistant_unbound")!({assistantId:42});await tick();expect(children).toHaveLength(2);expect(children[1].frames.at(-1)).toEqual({type:"browser-profile-stop"});children[1].stop();await tick();expect(children).toHaveLength(3);expect(children[2].frames[0].configuration.assistantIds).toEqual([43]);
    const stop=a.stop();await tick();children[2].stop();await stop;
  });
});
