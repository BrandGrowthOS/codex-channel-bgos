import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPublicPeerReview,checkBrowserPrerequisites } from "../src/browser-profile-setup.js";
afterEach(()=>vi.restoreAllMocks());
async function readinessFixture(value:unknown){
  const bootstrap=await import(new URL("../vendor/browser-profile/lib/browser-bootstrap.mjs",import.meta.url).href);
  const readiness=vi.spyOn(bootstrap,"browserBootstrapReadiness").mockReturnValue(value);
  // A present executable cannot override recovery or a missing complete marker.
  const bundle=vi.spyOn(bootstrap,"bundledChromium").mockReturnValue({executable:process.execPath});
  const install=vi.spyOn(bootstrap,"ensureBrowser");return{readiness,bundle,install};
}
describe("Codex browser setup surfaces",()=>{
  it("reads only a bounded absolute public peer document and rejects malformed bytes",()=>{
    const directory=mkdtempSync(join(tmpdir(),"hoai-peer-review-test-")),file=join(directory,"public.json");
    try{
      writeFileSync(file,JSON.stringify({public:"synthetic public fingerprint only"}));expect(readPublicPeerReview(file)).toEqual({public:"synthetic public fingerprint only"});
      expect(()=>readPublicPeerReview("relative.json")).toThrow();expect(()=>readPublicPeerReview(directory)).toThrow();
      writeFileSync(file,'{"value":1}'+" ".repeat(8193));expect(()=>readPublicPeerReview(file)).toThrow();
      writeFileSync(file,Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0x22,0xc3,0x28,0x22,0x7d]));expect(()=>readPublicPeerReview(file)).toThrow();
    }finally{rmSync(directory,{recursive:true,force:true})}
  });
  it.each([["installed","bundled-cache-present"],["needs-install","automatic-first-use-download"]])("uses shared read-only readiness %s without claiming enrolled keyring setup",async(state,browser)=>{
    const f=await readinessFixture({state});const result=await checkBrowserPrerequisites();
    expect(result.browser).toBe(browser);expect(result.sandbox).toBe("required");expect(result.keyServiceAvailability).toBe("not-probed-without-an-enrolled-profile");expect(result.authorization).toBe("device-review-background-grant-and-session-confirmation-required");
    expect(f.readiness).toHaveBeenCalledTimes(1);expect(f.bundle).not.toHaveBeenCalled();expect(f.install).not.toHaveBeenCalled();
  });
  it.each(["installing","recovery-required"])("refuses %s despite a present executable and never clears/installs",async state=>{
    const f=await readinessFixture({state});await expect(checkBrowserPrerequisites()).rejects.toMatchObject({code:"browser_install_recovery_required",message:"browser_install_recovery_required"});
    expect(f.bundle).not.toHaveBeenCalled();expect(f.install).not.toHaveBeenCalled();
  });
  it("fails closed on malformed, throwing and asynchronous readiness without leaking native diagnostics",async()=>{
    const f=await readinessFixture(null);
    for(const value of [null,{},[],{state:"unknown"},{state:1},Object.defineProperty({},"state",{get(){throw Error("PRIVATE_STATE_ERROR")}})]){
      f.readiness.mockReturnValue(value);await expect(checkBrowserPrerequisites()).rejects.toMatchObject({code:"browser_install_failed",message:"browser_install_failed"});
    }
    f.readiness.mockImplementation(()=>{throw Error("PRIVATE_NATIVE_ERROR")});await expect(checkBrowserPrerequisites()).rejects.toMatchObject({code:"browser_install_failed",message:"browser_install_failed"});
    f.readiness.mockImplementation(async()=>{throw Error("PRIVATE_ASYNC_ERROR")});await expect(checkBrowserPrerequisites()).rejects.toMatchObject({code:"browser_install_failed",message:"browser_install_failed"});
    expect(f.install).not.toHaveBeenCalled();
  });
});
