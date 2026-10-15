import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root=fileURLToPath(new URL("..",import.meta.url)),vendor=join(root,"vendor/browser-profile");
const manifest=JSON.parse(readFileSync(join(vendor,"source.json"),"utf8"));
const files=(directory:string,prefix=""):string[]=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(directory,entry.name),prefix+entry.name+"/"):[prefix+entry.name]);
describe("the shared managed browser runtime shipped to Codex",()=>{
  it("pins the exact complete source closure and both module boundaries",()=>{
    expect(manifest.repository).toBe("BrandGrowthOS/bgos-claude-plugin");expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/);expect(manifest.entry).toBe("bin/hoai-browser-host.mjs");
    expect(files(vendor).sort()).toEqual([...Object.keys(manifest.files),"package.json","source.json"].sort());expect(Object.keys(manifest.files).length).toBeGreaterThan(30);
    for(const[name,pin]of Object.entries(manifest.files) as [string,{sha256:string}][]){expect(name).toMatch(/^(bin|lib)\/[A-Za-z0-9_./-]+\.(mjs|cjs|js|json)$/);expect(name.split("/")).not.toContain("..");const bytes=readFileSync(join(vendor,name));expect(bytes.includes(13),name).toBe(false);expect(createHash("sha256").update(bytes).digest("hex"),name).toBe(pin.sha256)}
    expect(JSON.parse(readFileSync(join(vendor,"package.json"),"utf8")).type).toBe("module");
    const require=createRequire(import.meta.url);expect(typeof require("../vendor/browser-profile/lib/browser-profile-core/crypto.js").sealCheckpoint).toBe("function");
    expect(JSON.parse(readFileSync(join(vendor,"lib/browser-profile-core/package.json"),"utf8")).type).toBe("commonjs");
    expect(readFileSync(join(root,".gitattributes"),"utf8")).toMatch(/^vendor\/browser-profile\/\*\* text eol=lf$/m);
  });
  it("imports the actual host and companion without starting a browser or process",async()=>{
    const host=await import(pathToFileURL(join(vendor,manifest.entry)).href),companion=await import(pathToFileURL(join(vendor,"lib/browser-profile-companion.mjs")).href);
    expect(typeof host.BrowserHost).toBe("function");expect(typeof host.PairingConnection).toBe("function");expect(typeof host.PlaywrightEngine).toBe("function");expect(typeof companion.AgentBrowserProfileCompanion).toBe("function");expect(host.isRunAsMain(import.meta.filename)).toBe(false);
  });
  it("checks its declared upstream commit when the source checkout is available",()=>{
    const source=process.env.HOAI_BROWSER_PROFILE_PLUGIN_SOURCE;
    if(!source)return; // Local byte pin above always runs on CI without the private sibling checkout.
    const result=spawnSync(process.execPath,[join(root,"scripts/vendor-browser-profile-runtime.mjs"),"--source",source,"--ref",manifest.sourceCommit],{encoding:"utf8",windowsHide:true});expect(result.status,result.stderr||result.stdout).toBe(0);
  });
});
