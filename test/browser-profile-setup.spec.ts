import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPublicPeerReview,checkBrowserPrerequisites } from "../src/browser-profile-setup.js";
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
  it("reports cached or automatic bundled browser setup without claiming an enrolled unlocked keyring",async()=>{
    const result=await checkBrowserPrerequisites();expect(result.sandbox).toBe("required");expect(["bundled-cache-present","automatic-first-use-download"]).toContain(result.browser);expect(result.keyServiceAvailability).toBe("not-probed-without-an-enrolled-profile");expect(result.authorization).toBe("device-review-background-grant-and-session-confirmation-required");
  });
});
