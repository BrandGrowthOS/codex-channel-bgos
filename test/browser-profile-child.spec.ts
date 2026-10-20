import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activity, main } from "../runtime/browser-profile-host.mjs";
import { shutdownDaemon } from "../src/daemon-shutdown.js";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const config=()=>({backendUrl:"http://127.0.0.1:12345",pairingToken:"SYNTHETIC_PAIRING_TOKEN_0123456789",pairingId:8,ownerUserId:"user_recipient",assistantIds:[42],directory:join(tmpdir(),"synthetic-child"),parentPid:process.ppid});
class Channel extends EventEmitter{connected=true;frames:any[]=[];send(value:unknown,done:()=>void){this.frames.push(value);done();return true}}
function fixture(extra:any={}){
  const channel=new Channel(),stdin=new PassThrough(),signals=new EventEmitter();
  const host={pool:{_slots:new Map()},connections:new Map(),retiringConnections:new Map(),installationActivity:()=>({pendingPhysicalOperations:0,cleanupUnknown:false}),start:vi.fn(),stop:vi.fn(async()=>{}),emergencyStopOwnedProfiles:vi.fn(async()=>({stopped:true}))};
  const create=vi.fn(()=>host),done=main({channel,stdin,signals,create,stopDeadlineMs:20,...extra});
  return{channel,stdin,signals,host,create,done};
}
describe("the actual common host child lifecycle",()=>{
  it.each(["ipc","eof","stdin-error","disconnect","signal"])("holds its positive stop receipt until physical cleanup settles (%s)",async reason=>{
    const f=fixture();let release!:()=>void;f.host.stop.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve}));
    f.channel.emit("message",{type:"browser-profile-configure",configuration:config()});expect(f.create).toHaveBeenCalledTimes(1);expect(f.channel.frames.at(-1)).toEqual({type:"browser-profile-ready"});
    // Duplicate configuration and all exit triggers share the same owned stop.
    f.channel.emit("message",{type:"browser-profile-configure",configuration:config()});
    if(reason==="ipc")f.channel.emit("message",{type:"browser-profile-stop"});
    if(reason==="eof")f.stdin.end();if(reason==="disconnect")f.channel.emit("disconnect");if(reason==="signal")f.signals.emit("SIGTERM");
    if(reason==="stdin-error")f.stdin.emit("error",Error("synthetic stdin failure"));
    await tick();expect(f.host.stop).toHaveBeenCalledTimes(1);expect(f.channel.frames.some(v=>v.type==="browser-profile-stopped")).toBe(false);
    release();expect(await f.done).toBe(0);expect(f.channel.frames.at(-1)).toEqual({type:"browser-profile-stopped",code:0});expect(f.host.emergencyStopOwnedProfiles).not.toHaveBeenCalled();
    expect(f.channel.listenerCount("message")).toBe(0);expect(f.signals.listenerCount("SIGTERM")).toBe(0);expect(f.stdin.listenerCount("end")).toBe(0);
  });
  it("retains the host before start so partial start failure still drains its exact resources",async()=>{
    const f=fixture();f.host.start.mockImplementation(()=>{throw Error("synthetic partial start")});f.channel.emit("message",{type:"browser-profile-configure",configuration:config()});
    expect(await f.done).toBe(0);expect(f.host.stop).toHaveBeenCalledTimes(1);expect(f.channel.frames[0]).toEqual({type:"browser-profile-refused",code:"browser_profile_configuration_invalid"});expect(f.channel.frames.some(v=>v.type==="browser-profile-ready")).toBe(false);
  });
  it("returns an unsuccessful receipt after a refused guarded save even if emergency process cleanup succeeds",async()=>{
    const f=fixture();f.host.stop.mockRejectedValue(Error("synthetic guarded save failure"));f.channel.emit("message",{type:"browser-profile-configure",configuration:config()});f.channel.emit("message",{type:"browser-profile-stop"});
    expect(await f.done).toBe(1);expect(f.host.emergencyStopOwnedProfiles).toHaveBeenCalledTimes(1);expect(f.channel.frames.at(-1)).toEqual({type:"browser-profile-stopped",code:1});
  });
  it("refuses an unrelated parent before constructing any browser host",async()=>{
    const f=fixture();try{f.channel.emit("message",{type:"browser-profile-configure",configuration:{...config(),parentPid:process.ppid+1}});await tick();expect(f.create).not.toHaveBeenCalled();}finally{f.channel.emit("message",{type:"browser-profile-stop"});expect(await f.done).toBe(0);}
  });
  it("counts real legacy starts, held stops and failed cleanup after slot.engine clears",async()=>{
    const {BrowserPool}=await import("../vendor/browser-profile/bin/hoai-browser-host.mjs");let release!:()=>void;
    const engine={alive:true,start:vi.fn(async()=>{}),stop:vi.fn(()=>new Promise<void>(resolve=>{release=resolve}))};
    const pool=new BrowserPool({agentRoot:join(tmpdir(),"synthetic-activity"),createEngine:async()=>engine});
    const host={pool,connections:new Map(),retiringConnections:new Map(),installationActivity:()=>({pendingPhysicalOperations:0,cleanupUnknown:false})},ctx={assistantId:42,principal:"user-user_recipient"};await pool.acquire(ctx);expect(activity(host)).toEqual({activeProfiles:1,pendingWork:0});
    const stopping=pool.release(ctx);await tick();expect(activity(host)).toEqual({activeProfiles:0,pendingWork:1});release();await stopping;expect(activity(host)).toEqual({activeProfiles:0,pendingWork:0});
    await pool.acquire(ctx);engine.stop.mockRejectedValueOnce(Error("synthetic cleanup unknown"));await expect(pool.release(ctx)).rejects.toThrow();expect(activity(host)).toEqual({activeProfiles:0,pendingWork:1});
  });
  it("includes Companion positive physical counters and unknown cleanup, with an occupied older version staying busy",()=>{
    const companion:any={activity:()=>({activeProfiles:1,pendingPhysicalOperations:2,cleanupUnknown:true})};const connection={profileCompanion:companion};
    const host={pool:{_slots:new Map()},connections:new Map([[1,connection]]),retiringConnections:new Map([[1,connection]]),installationActivity:()=>({pendingPhysicalOperations:0,cleanupUnknown:false})};expect(activity(host)).toEqual({activeProfiles:1,pendingWork:4});
    companion.activity=()=>({activeProfiles:0,pendingPhysicalOperations:0,cleanupUnknown:false});host.retiringConnections.clear();expect(activity(host)).toEqual({activeProfiles:0,pendingWork:0});
    delete companion.activity;companion.records=new Map([[1,{runtime:{state:"disposed"},stopTask:new Promise(()=>{})}]]);expect(activity(host).pendingWork).toBe(1);
  });
  it("does not report exit zero when daemon cleanup is unconfirmed",async()=>{
    const report=vi.fn();expect(await shutdownDaemon(async()=>{},report)).toBe(0);expect(report).not.toHaveBeenCalled();
    expect(await shutdownDaemon(async()=>{throw Error("synthetic private failure")},report)).toBe(1);expect(report).toHaveBeenCalledWith("daemon_cleanup_unconfirmed");
  });
  it("counts original installer work and unknown cleanup independently of browser slots",()=>{
    let value={pendingPhysicalOperations:3,cleanupUnknown:false};
    const host={pool:{_slots:new Map()},connections:new Map(),retiringConnections:new Map(),installationActivity:()=>value};
    expect(activity(host)).toEqual({activeProfiles:0,pendingWork:3});
    value={pendingPhysicalOperations:0,cleanupUnknown:true};expect(activity(host)).toEqual({activeProfiles:0,pendingWork:1});
    value={pendingPhysicalOperations:0,cleanupUnknown:false};expect(activity(host)).toEqual({activeProfiles:0,pendingWork:0});
  });
  it("keeps malformed, missing, throwing and asynchronous installation activity busy",async()=>{
    const host:any={pool:{_slots:new Map()},connections:new Map(),retiringConnections:new Map()};
    expect(activity(host)).toEqual({activeProfiles:0,pendingWork:1});
    for(const value of [null,{},[],{pendingPhysicalOperations:-1,cleanupUnknown:false},{pendingPhysicalOperations:NaN,cleanupUnknown:false},{pendingPhysicalOperations:0,cleanupUnknown:"false"}]){
      host.installationActivity=()=>value;expect(activity(host)).toEqual({activeProfiles:0,pendingWork:1});
    }
    host.installationActivity=()=>{throw Error("PRIVATE_INSTALLER_ERROR")};expect(activity(host)).toEqual({activeProfiles:0,pendingWork:1});
    host.installationActivity=async()=>{throw Error("PRIVATE_ASYNC_ERROR")};expect(activity(host)).toEqual({activeProfiles:0,pendingWork:1});await tick();
    Object.defineProperty(host,"installationActivity",{get(){throw Error("PRIVATE_GETTER_ERROR")}});expect(activity(host)).toEqual({activeProfiles:0,pendingWork:1});
  });
  it("actual common host IPC remains busy and its stop receipt waits the original installation drain",async()=>{
    const {BrowserHost}=await import("../vendor/browser-profile/bin/hoai-browser-host.mjs");
    let release!:()=>void,operations=1,cancelled=0;
    const drain=new Promise<void>(resolve=>{release=()=>{operations=0;resolve()}});
    const host=new BrowserHost({agentRoot:join(tmpdir(),"synthetic-installer-host"),env:{},browserTools:async()=>[],listDir:()=>[],createEngine:async()=>{throw Error("must not launch a browser")},
      browserInstallations:{activity:()=>({pendingPhysicalOperations:operations,cleanupUnknown:false}),cancel(){cancelled++},whenDrained:()=>drain}});
    const f=fixture({create:()=>host,stopDeadlineMs:1000});
    try{
      f.channel.emit("message",{type:"browser-profile-configure",configuration:config()});
      expect(f.channel.frames.find(value=>value.type==="browser-profile-state")).toEqual({type:"browser-profile-state",activeProfiles:0,pendingWork:1});
      f.channel.emit("message",{type:"browser-profile-stop"});await tick();expect(cancelled).toBe(1);
      expect(activity(host)).toEqual({activeProfiles:0,pendingWork:1});expect(f.channel.frames.some(value=>value.type==="browser-profile-stopped")).toBe(false);
      release();expect(await f.done).toBe(0);expect(f.channel.frames.at(-1)).toEqual({type:"browser-profile-stopped",code:0});
    }finally{release();f.channel.emit("message",{type:"browser-profile-stop"});await f.done;f.stdin.end()}
  });
});
