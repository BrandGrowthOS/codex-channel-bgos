import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, ForkOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProfileHost } from "../src/browser-profile-host.js";
import { configuration } from "../runtime/browser-profile-configuration.mjs";

const config=(extra={})=>({backendUrl:"http://127.0.0.1:12345",pairingToken:"SYNTHETIC_PAIRING_TOKEN_0123456789",pairingId:8,ownerUserId:"user_recipient",assistantIds:[42],directory:join(tmpdir(),"synthetic-profile-host"),parentPid:process.pid,...extra});
class Child extends EventEmitter {
  sent:any[]=[];stdin=new PassThrough();stderr=new PassThrough();pid=12345;
  send(value:unknown,callback?:(error:null)=>void){this.sent.push(value);callback?.(null);return true}
  ready(){this.emit("message",{type:"browser-profile-state",activeProfiles:0,pendingWork:0});this.emit("message",{type:"browser-profile-ready"})}
  stopped(code=0){this.emit("message",{type:"browser-profile-stopped",code});this.emit("exit",code,null)}
}
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve))};
function fixture(options={}){
  const children:Child[]=[],spawn=vi.fn((_entry:string,_args:string[],_options:ForkOptions)=>{const child=new Child();children.push(child);return child as unknown as ChildProcess});
  const manager=new BrowserProfileHost({spawn,environment:{PATH:"/usr/bin",HOME:"/tmp/synthetic-home",OPENAI_API_KEY:"SYNTHETIC_DO_NOT_INHERIT",SSH_AUTH_SOCK:"/secret-ssh",NODE_OPTIONS:"--inspect"},...options});
  return{manager,children,spawn};
}
afterEach(()=>vi.useRealTimers());
describe("Codex managed browser process ownership",()=>{
  it("uses one exact IPC configuration with a sanitized child environment and private stdio",async()=>{
    const {manager,children,spawn}=fixture();expect((await manager.synchronize(config())).state).toBe("starting");const child=children[0];
    expect(child.sent).toEqual([{type:"browser-profile-configure",configuration:configuration(config())}]);
    const options=spawn.mock.calls[0][2];expect(options.env).toEqual({PATH:"/usr/bin",HOME:"/tmp/synthetic-home"});expect(options.stdio).toEqual(["pipe","ignore","pipe","ipc"]);expect(options.execArgv).toEqual([]);
    child.ready();expect(manager.status()).toEqual({state:"running",busy:false,activeProfiles:0,pendingWork:0});await manager.synchronize(config());expect(spawn).toHaveBeenCalledTimes(1);
    const stopping=manager.stop();await tick();expect(child.sent.at(-1)).toEqual({type:"browser-profile-stop"});expect(manager.busy).toBe(true);child.stopped();await stopping;expect(manager.status().state).toBe("stopped");
  });
  it("includes active profile and retained physical work in the update busy decision",async()=>{
    const {manager,children}=fixture();await manager.synchronize(config());const child=children[0];expect(manager.busy).toBe(true);child.ready();expect(manager.busy).toBe(false);
    child.emit("message",{type:"browser-profile-state",activeProfiles:1,pendingWork:0});expect(manager.busy).toBe(true);child.emit("message",{type:"browser-profile-state",activeProfiles:0,pendingWork:1});expect(manager.busy).toBe(true);
    for(const data of [{activeProfiles:-1,pendingWork:0},{activeProfiles:0,pendingWork:5000},{activeProfiles:{deep:true},pendingWork:0}])child.emit("message",{type:"browser-profile-state",...data});expect(manager.status().pendingWork).toBe(1);
    const stopped=manager.stop();await tick();child.stopped();await stopped;
  });
  it("requires both its original stop receipt and actual process exit",async()=>{
    const {manager,children}=fixture();await manager.synchronize(config());children[0].ready();let settled=false;const work=manager.stop().then(()=>{settled=true});await tick();
    children[0].emit("message",{type:"browser-profile-stopped",code:0});await tick();expect(settled).toBe(false);expect(manager.busy).toBe(true);children[0].emit("exit",0,null);await work;expect(settled).toBe(true);
  });
  it("waits for the requested receipt when process exit is delivered first",async()=>{
    const {manager,children}=fixture();await manager.synchronize(config());children[0].ready();let settled=false;const work=manager.revoke().then(()=>{settled=true;return "stopped"},()=>{settled=true;return "refused"});await tick();
    children[0].emit("exit",0,null);await tick();expect(settled).toBe(false);expect(manager.busy).toBe(true);
    children[0].emit("message",{type:"browser-profile-stopped",code:0});expect(await work).toBe("stopped");expect(manager.status().state).toBe("stopped");await manager.stop();
  });
  it("invalidates authorization awaiting its environment before any child exists",async()=>{
    const {manager,spawn}=fixture();let release!:(env:Record<string,string>)=>void;
    vi.spyOn(manager as any,"environment").mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}));
    const pending=manager.synchronize(config());const result=expect(pending).rejects.toThrow("browser_profile_cleanup_unconfirmed");await tick();
    await manager.revoke();release({PATH:"/usr/bin"});await result;expect(spawn).not.toHaveBeenCalled();await manager.stop();
  });
  it("invalidates queued replacement while the old physical cleanup is held",async()=>{
    const {manager,children,spawn}=fixture();await manager.synchronize(config());children[0].ready();
    const pending=manager.synchronize(config({assistantIds:[43]})),result=expect(pending).rejects.toThrow();await tick();const revoked=manager.revoke();children[0].stopped();await revoked;await result;expect(spawn).toHaveBeenCalledTimes(1);await manager.stop();
  });
  it("allows a fresh authorized synchronization of the same config after a confirmed revoke",async()=>{
    const {manager,children,spawn}=fixture();await manager.synchronize(config());children[0].ready();const revoke=manager.revoke();children[0].stopped();await revoke;
    await manager.synchronize(config());expect(spawn).toHaveBeenCalledTimes(2);children[1].ready();const stopped=manager.stop();children[1].stopped();await stopped;
  });
  it("never replaces an exited child without a positive requested cleanup receipt",async()=>{
    const {manager,children,spawn}=fixture();await manager.synchronize(config());children[0].ready();children[0].emit("exit",0,null);expect(manager.status().state).toBe("recovery-required");
    await manager.synchronize(config());expect(spawn).toHaveBeenCalledTimes(1);await expect(manager.synchronize(config({assistantIds:[42,43]}))).rejects.toThrow("browser_profile_cleanup_unconfirmed");expect(spawn).toHaveBeenCalledTimes(1);await expect(manager.stop()).rejects.toThrow();
  });
  it("retains uncertainty after a timeout even when late process exit arrives",async()=>{
    const {manager,children,spawn}=fixture({stopTimeoutMs:10});await manager.synchronize(config());children[0].ready();await expect(manager.revoke()).rejects.toThrow("browser_profile_cleanup_unconfirmed");
    children[0].stopped();expect(manager.status().state).toBe("recovery-required");expect(manager.busy).toBe(true);await expect(manager.synchronize(config({pairingToken:"SYNTHETIC_DIFFERENT_TOKEN_0123456789"}))).rejects.toThrow();expect(spawn).toHaveBeenCalledTimes(1);await expect(manager.stop()).rejects.toThrow();
  });
  it("waits for the old owned child to stop before a changed authorized catalog is configured",async()=>{
    const {manager,children,spawn}=fixture();await manager.synchronize(config());children[0].ready();const changed=manager.synchronize(config({assistantIds:[43,42]}));await tick();expect(spawn).toHaveBeenCalledTimes(1);
    children[0].stopped();await changed;expect(spawn).toHaveBeenCalledTimes(2);children[1].ready();children[0].emit("message",{type:"browser-profile-state",activeProfiles:99,pendingWork:99});expect(manager.busy).toBe(false);
    const stop=manager.stop();await tick();children[1].stopped();await stop;
  });
  it("does not forward arbitrary settings or invoke configuration accessors",async()=>{
    const {manager,spawn}=fixture();let reads=0;const value=config();Object.defineProperty(value,"pairingToken",{enumerable:true,get(){reads++;return "malicious"}});expect(()=>manager.synchronize(value)).toThrow();expect(reads).toBe(0);
    for(const extra of [{backendUrl:"https://example.com/path"},{backendUrl:"http://example.com"},{ownerUserId:"owner"},{assistantIds:[42,42]},{parentPid:0},{directory:"relative"},{extra:true}])expect(()=>manager.synchronize(config(extra))).toThrow();expect(spawn).not.toHaveBeenCalled();await manager.stop();
  });
  it("rejects array accessors, holes, extra properties, iterators and NUL paths without invoking them",()=>{
    let reads=0;const accessor=[42];Object.defineProperty(accessor,0,{enumerable:true,get(){reads++;return 42}});
    const iterator=[42];Object.defineProperty(iterator,Symbol.iterator,{value(){reads++;return [42][Symbol.iterator]()}});
    for(const assistantIds of [accessor,iterator,new Array(1),Object.assign([42],{extra:1})])expect(()=>configuration(config({assistantIds}))).toThrow();
    expect(()=>configuration(config({directory:join(tmpdir(),"bad\0path")}))).toThrow();expect(reads).toBe(0);
  });
});

describe("the actual common browser host behind Codex",()=>{
  it("discovers only its virtual exact pairing and adopts the unchanged Companion",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"hoai-codex-browser-test-"));let host:any;const sockets:any[]=[];
    try{
      const entry=await import("../runtime/browser-profile-host.mjs"),io=vi.fn((_url:string,options:any)=>{const socket=Object.assign(new EventEmitter(),{connected:false,id:"",disconnect:vi.fn(),connect:vi.fn()});sockets.push({socket,options});return socket});
      host=entry.createHost({config:config({directory}),io});host.start();expect(host.connections.size).toBe(1);expect(sockets).toHaveLength(1);const connection=[...host.connections.values()][0] as any;
      expect(connection.pairing.assistantIds).toEqual([42]);expect(connection.pairing.pairingId).toBe(8);expect(connection.pairing.token).toBe(config().pairingToken);expect(connection.profileCompanion.constructor.name).toBe("AgentBrowserProfileCompanion");
      expect(sockets[0].options.query.pairingToken).toBe(config().pairingToken);expect(sockets[0].options.auth.role).toBe("browser_host");expect(entry.activity(host)).toEqual({activeProfiles:0,pendingWork:0});
    }finally{await host?.stop();rmSync(directory,{recursive:true,force:true})}
  });
});
