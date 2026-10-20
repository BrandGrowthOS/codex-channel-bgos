# Managed browser profiles in the Codex plugin

The package includes its browser host, profile companion, encryption and checkpoint codecs, and a pinned Playwright Chromium installer. Start the paired Codex daemon normally. After HOAI confirms the current pairing and bound agents, the daemon starts one owned Node child for that exact catalog. Pairing credentials go through private IPC. Browser traffic goes through the configured HOAI server.

The foreground browser is the person's native local HOAI browser. The agent can separately run its browser on its own Linux machine using the latest confirmed profile checkpoint. Profiles belong to the acting person and agent together, including share recipients. The agent's sharer does not receive another person's browser session or saved logins.

## Fresh machine setup

1. Install this plugin and pair it using the normal HOAI setup. No manual copy of the browser host or Claude plugin is required. The browser companion starts with the Codex daemon.
2. The Linux agent needs normal Chromium system libraries, kernel sandbox support, `/usr/bin/gdbus`, `/usr/bin/secret-tool`, and a persistent Secret Service collection. The collection must already be unlocked in the daemon's user session. An SSH-only session without this service requires OS setup by its operator. The plugin does not install privileged OS packages, unlock a keyring, disable the sandbox, or store keys in plaintext.
3. Run `codex-channel-bgos browser-check`. This checks that the bundled browser resolver is present and reports its cache state and setup requirements. It does not attest an enrolled profile or unlock a key service. The pinned Chromium revision downloads into the user's cache automatically on first browser use if absent.
4. In HOAI, the person opens Browser > Devices, selects the exact agent machine, compares its full public fingerprint, and grants background use separately. Installation alone grants no profile access.
5. The machine operator reviews the exact public desktop peer document exported by HOAI and compares its full fingerprint through a trusted channel. Run `codex-channel-bgos browser-review-peer /absolute/path/public-peer.json --confirm-fingerprint <64-character-fingerprint>`. Use the same `--home` or `--assistant-id` selection as the running daemon. This stores a reviewed public pin; it does not grant background use or site permissions.
6. The person explicitly confirms the desired browser session in HOAI. A missing grant, locked key service, changed authority or uncertain write is reported rather than silently creating a different profile.

The setup command reads this Codex pairing and this agent home's browser state. It does not read an installed Claude plugin's credentials or browser directory.

## Handover and sign-ins

The agent uses the existing `hoai_browser` tools. The plugin's developer instructions explain actor scoping and handover limits. A human trust decision, password, security code or payment detail must never be supplied by the agent on the person's behalf.

Website data and saved logins move in encrypted checkpoints only after source shutdown is positively confirmed. Device enrollment, key review, background-use consent and permission to act on a website are separate decisions. A saved password is protected by the local OS key service and profile encryption; it is available in plaintext to the authorized browser process while used. The OS administrator and software running as that same authorized user remain trusted.

A checkpoint does not move a live JavaScript document, unfinished OAuth flow, active popup relationship, WebRTC session, passkey or device-bound credential. Finish sign-in on its current machine before transferring. Some providers require another sign-in on a new device. Never transfer callback URLs containing authorization codes or paste passwords into chat to work around a refusal.

The daemon waits for a positive guarded browser stop receipt and actual child exit before replacing its browser process. A timeout or failed save remains recovery-required and prevents automatic replacement. Updates count an active profile, retained physical work and unknown cleanup as busy.

## Source and security boundaries

`vendor/browser-profile/source.json` records the exact committed upstream source closure and SHA-256 of every vendored file. Regenerate it with `scripts/vendor-browser-profile-runtime.mjs`; never edit a vendored runtime by hand. The package keeps the upstream CommonJS codec boundaries and license notices.

HOAI coordinates authorization, encrypted escrow and relay routing. The endpoint verifies exact profile authority and locally reviewed signing keys. This is not protection against an attacker who controls the trusted HOAI coordinator or an enrolled machine. After handing a page back, its DOM and site scripts may retain data already entered; do not claim complete exclusion of the agent from a page's prior state.

The feature branch's proof report distinguishes unit fixtures, actual native browser evidence, Linux provider qualification and remaining acceptance work. A fixture result is not proof that a particular external login provider or device-bound session can transfer.
