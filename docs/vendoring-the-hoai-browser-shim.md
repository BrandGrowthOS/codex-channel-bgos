# Re-vendoring the HOAI browser shim (checklist)

`vendor/hoai-browser-mcp.mjs` is a byte-identical **copy** of the BGOS source of
truth, `frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs`. It is
not a fork and must never be edited here: the shim is framework neutral by
design (relay plan decision 11.2, it never reads a plugin's files and takes its
credentials from `HOAI_RELAY_*` env), so every channel plugin ships the same
bytes and only the launcher differs. `bgos-claude-plugin` vendors the same file
as `bin/hoai-browser-mcp.mjs` with the same pin.

The expected hash lives in `vendor/hoai-browser-mcp.vendor.json` and is checked
by `test/browser-shim-vendor.spec.ts` on every `npm test`. Fix the shim in BGOS,
then bring the copy across with this list.

1. **Copy the file, do not patch it.** From a machine that has both trees:

   ```bash
   cp "<bgos>/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs" vendor/hoai-browser-mcp.mjs
   ```

2. **Hash both sides and confirm they agree.** The BGOS side must be
   **committed and pushed** there, or the claim is unverifiable from git and a
   reviewer diffing the two committed blobs sees them disagree (this is exactly
   how round 1 of the relay PR recorded a hash that only ever matched
   uncommitted BGOS working-tree WIP):

   ```bash
   sha256sum vendor/hoai-browser-mcp.mjs
   git -C "<bgos>" show origin/<branch>:frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs | sha256sum
   ```

3. **Bump the pin.** Put the new hash and today's date in
   `vendor/hoai-browser-mcp.vendor.json`. This is the step that makes drift
   loud: the guard fails until the pin and the file agree, so a re-vendor cannot
   land without someone stating the new hash in the tree.

4. **Run the guard with the cross-tree check armed**, on the machine that has
   both trees:

   ```bash
   HOAI_BROWSER_SHIM_SOURCE="<bgos>/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs" \
     npx vitest run test/browser-shim-vendor.spec.ts
   ```

   Without that variable the cross-tree case is skipped: BGOS is a separate
   private repo and is not on this repo's CI runner, so CI can only check the
   copy against the pin, never against BGOS.

5. **Run the behavioural cover**, which catches a shim that no longer *works*
   rather than one that merely changed:

   ```bash
   npx vitest run test/browser-mcp.spec.ts test/browser-relay-identity.spec.ts
   npm test && npm run lint
   ```

6. **Bump `package.json`** so the fleet can actually receive the new bytes
   (`vendor/` ships through the `files` list). A vendored fix nobody publishes
   reaches nobody.

7. **The other plugin ships the same bytes.** Re-vendor
   `bgos-claude-plugin`'s `bin/hoai-browser-mcp.mjs` in the same round, or say
   plainly that it is behind.

## What none of this catches

Nothing in THIS repo fires when the BGOS shim changes and this copy does not
move, which is the drift that actually happened (2026-09-12, in the sibling
plugin: the shim was fixed twice in a week and the stale copy shipped with a
dead relay lane). A check for that has to live on the BGOS side. Until it does,
step 1 of any BGOS shim fix is "re-vendor both plugins", and the only automatic
protection here is behavioural.
