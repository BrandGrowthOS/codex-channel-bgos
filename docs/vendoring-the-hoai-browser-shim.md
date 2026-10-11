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

BGOS's `browser-shim-vendor-parity.yml` workflow compares its canonical shim
with both vendors' `main` branches. The workflow arms each vendor's cross-tree
check and requires a deliberately wrong source to fail. Coordinate companion
PRs when changing the shim; an unmerged companion can leave that check red.

## Managed recipient context scope

The bundled shim accepts a signed managed turn context when its launcher sets
`HOAI_RELAY_CONTEXT_FILE`, `HOAI_RELAY_OWNER_USER_ID` and
`HOAI_RELAY_CLIENT_PID`. It then forces relay routing, validates the live signed
context and matching prompt marker, and retains the admitted actor for the
original request, polling and cancellation. The real-child tests in
`test/browser-managed-context.spec.ts` exercise the exact bundled file.

`CodexHost` publishes that context before each attributed turn starts, using
the authenticated delivery's explicit human sender or the server's reserved
scheduler actor. The envelope's owner ID and message text cannot supply it.
The managed launcher always uses the bundled shim, including saved-thread
resume, forks and detached work, so an older app-installed copy cannot ignore
the guard. Detached work has separate context files. Stop, reset, turn end,
and daemon close invalidate the marker. Standalone shim use without the
managed environment keeps its existing behavior.

A goal continuation can inherit only the last verified actor for that thread
in this daemon process. After restart, an unattributed goal has no browser
authority until a new attributed turn runs. Meetings, unknown deliveries,
and invisible read-only consultations cannot use a personal browser. The
channel does not invent an owner fallback for these cases. This contract
covers the browser relay, native Boards calls and schedule, list and cancel
calls. These private tools carry the admitted actor in `X-BGOS-Acting-User`, including
verified goal continuations; unknown actors are refused before HTTP. Other
native APIs are not a parity claim here. Signed context
files protect against stale turn and process races; an attacker who controls
the same OS account and its pairing secret is outside this local boundary.
