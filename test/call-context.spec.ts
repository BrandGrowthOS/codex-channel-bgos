import { describe, it, expect } from "vitest";
import { buildCallOwnerBody } from "../src/hoai-shared/call-owner.js";
it("preserves private context, opening, Unicode and paths, with unchanged legacy wire payload", () => {
 const context = 'Path C:\\Work\\notes.md\n"approved" 🙂';
 expect(JSON.parse(JSON.stringify(buildCallOwnerBody({ assistantId: 7, context, openingMessage: "Hello." })))).toEqual({ assistantId: 7, context, openingMessage: "Hello." });
 expect(buildCallOwnerBody({ assistantId: 7 })).toEqual({ assistantId: 7 });
 expect(() => buildCallOwnerBody({ assistantId: 7, context: "x".repeat(4001) })).toThrow(/4000/);
});