import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root=fileURLToPath(new URL("..",import.meta.url)),temporary:string[]=[];
afterEach(()=>{for(const directory of temporary.splice(0))rmSync(directory,{recursive:true,force:true})});
function fixture(change?:(manifest:any)=>void){
 const directory=mkdtempSync(join(tmpdir(),"hoai-vendor-workers-"));temporary.push(directory);
 const source=join(directory,"source"),consumer=join(directory,"consumer");mkdirSync(join(source,"bin"),{recursive:true});mkdirSync(join(source,"lib/browser-profile-core"),{recursive:true});mkdirSync(join(consumer,"scripts"),{recursive:true});
 writeFileSync(join(consumer,"package.json"),'{"type":"module"}\n');copyFileSync(join(root,"scripts/vendor-browser-profile-runtime.mjs"),join(consumer,"scripts/vendor-browser-profile-runtime.mjs"));
 const files:Record<string,string>={
  "start.js":"const {Worker}=require('node:worker_threads'),path=require('node:path');module.exports=()=>new Promise((resolve,reject)=>{const worker=new Worker(path.join(__dirname,'worker.js'));let value;worker.on('message',message=>{value=message});worker.on('error',reject);worker.on('exit',code=>code===0?resolve(value):reject(Error('worker refused')))});\n",
  "worker.js":"require('node:worker_threads').parentPort.postMessage('ACTUAL_DYNAMIC_WORKER');\n"
 };
 for(const[name,bytes]of Object.entries(files))writeFileSync(join(source,"lib/browser-profile-core",name),bytes);
 const manifest={version:1,sourceCommit:"a".repeat(40),files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,{sha256:createHash("sha256").update(bytes).digest("hex")}]))};change?.(manifest);
 writeFileSync(join(source,"lib/browser-profile-core/vendor.json"),JSON.stringify(manifest)+"\n");writeFileSync(join(source,"lib/browser-profile-core/package.json"),'{"type":"commonjs"}\n');
 writeFileSync(join(source,"lib/browser-install-lifetime.mjs"),"export const lifetimeToken='ACTUAL_PINNED_LIFETIME';\n");
 writeFileSync(join(source,"lib/browser-bootstrap.pin.json"),'{"revision":1248}\n');
 writeFileSync(join(source,"lib/browser-bootstrap.mjs"),"import{readFileSync}from'node:fs';import{lifetimeToken}from'./browser-install-lifetime.mjs';export const readiness=()=>({token:lifetimeToken,revision:JSON.parse(readFileSync(new URL('./browser-bootstrap.pin.json',import.meta.url),'utf8')).revision});\n");
 writeFileSync(join(source,"package.json"),'{"type":"module","version":"0.0.0-fixture"}\n');writeFileSync(join(source,"bin/hoai-browser-host.mjs"),"import {createRequire}from'node:module';export{readiness}from'../lib/browser-bootstrap.mjs';const require=createRequire(import.meta.url);export const probe=()=>require('../lib/browser-profile-core/start.js')();\n");
 const git=(args:string[])=>{const result=spawnSync("git",["-C",source,...args],{encoding:"utf8",windowsHide:true});expect(result.status,result.stderr).toBe(0);return result.stdout.trim()};
 git(["init","--quiet"]);git(["add","."]);git(["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","core.autocrlf=false","commit","--quiet","-m","Fixture dependency closure"]);
 const ref=git(["rev-parse","HEAD"]),run=(write=true)=>spawnSync(process.execPath,[join(consumer,"scripts/vendor-browser-profile-runtime.mjs"),"--source",source,"--ref",ref,...(write?["--write"]:[])],{encoding:"utf8",windowsHide:true,timeout:15000});
 return{consumer,run};
}
describe("committed profile core worker closure",()=>{
 it("ships and executes a manifest-pinned dynamic worker without a static import",()=>{
  const f=fixture(),copied=f.run();expect(copied.status,copied.stderr).toBe(0);
  const vendor=join(f.consumer,"vendor/browser-profile"),manifest=JSON.parse(readFileSync(join(vendor,"source.json"),"utf8"));
  expect(manifest.files["lib/browser-profile-core/worker.js"]).toBeDefined();
  const launched=spawnSync(process.execPath,["--input-type=module","-e","import {probe}from'./vendor/browser-profile/bin/hoai-browser-host.mjs';console.log(await probe())"],{cwd:f.consumer,encoding:"utf8",timeout:15000,windowsHide:true});
  expect(launched.status,launched.stderr).toBe(0);expect(launched.stdout.trim()).toBe("ACTUAL_DYNAMIC_WORKER");expect(f.run(false).status).toBe(0);
 },30000);
 it("ships the committed static lifetime helper and URL-resolved bootstrap pin",()=>{
  const f=fixture(),copied=f.run();expect(copied.status,copied.stderr).toBe(0);
  const manifest=JSON.parse(readFileSync(join(f.consumer,"vendor/browser-profile/source.json"),"utf8"));
  for(const name of ["lib/browser-bootstrap.mjs","lib/browser-install-lifetime.mjs","lib/browser-bootstrap.pin.json"])expect(manifest.files[name],name).toBeDefined();
  const launched=spawnSync(process.execPath,["--input-type=module","-e","import{readiness}from'./vendor/browser-profile/bin/hoai-browser-host.mjs';console.log(JSON.stringify(readiness()))"],{cwd:f.consumer,encoding:"utf8",timeout:15000,windowsHide:true});
  expect(launched.status,launched.stderr).toBe(0);expect(JSON.parse(launched.stdout)).toEqual({token:"ACTUAL_PINNED_LIFETIME",revision:1248});expect(f.run(false).status).toBe(0);
 },30000);
 it("refuses a missing, traversing, oversized or mismatched core inventory",()=>{
  for(const change of [(x:any)=>{x.files["missing.js"]={sha256:"b".repeat(64)}},(x:any)=>{x.files["../escape.js"]={sha256:"b".repeat(64)}},(x:any)=>{x.files=Array(129).fill({sha256:"b".repeat(64)})},(x:any)=>{x.files["worker.js"].sha256="b".repeat(64)}]){
   const f=fixture(change),result=f.run();expect(result.status).toBe(1);expect(result.stderr).toMatch(/Invalid committed profile core|Committed profile core pin differs/);
  }
 },30000);
});
