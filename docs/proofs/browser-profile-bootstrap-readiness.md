# Codex browser readiness and installer lifetime qualification

Committed Codex source `4dc368f714ccd2b84de10850d9d0aff3f5c64d5d` uses the shared read-only readiness API and counts original installer activity in its existing child status. Installing, recovery-required and malformed states fail closed with fixed safe errors. The existing Common stop/drain promise owns physical installation cleanup; the adapter adds no second stop mechanism.

All 77 vendored runtime files equal immutable Common `6c8a07277d1de57e85b24d8cdeacf3992fac1391` Git bytes and manifest pins. The unchanged generator includes the static lifetime helper and URL-resolved bootstrap pin. Dependencies, lockfile and scanner source are unchanged. The exact change contains five adapter/setup/test paths and eight generated vendor paths.

The explicit prior 19-file affected union passed 202 tests with zero failed, pending/skipped or todo cases on Windows Node24.16.0 and private Playwright1.64.1 dependencies. Build and full noEmit exited zero. Both cross-tree source opt-ins were enabled. All 429 source inputs remained unchanged before/after; all 13 changed files are LF and now match the committed blobs.

The tests use imported production adapter/setup code, actual Common BrowserHost and IPC composition with an isolated held installer controller, plus a synthetic committed dependency fixture. They qualify safe readiness reporting, pending/unknown lifetime reporting and complete asset delivery. They do not launch an installer, browser, keyring or native session.

Three copied-source executable drills preserve unchanged tests:

| Loaded mutation | Failing result | Exact restored whole file |
| --- | --- | --- |
| Omit installer activity counting, line34 | 3 failures,11 passes | 14 passed |
| Restore the exact prior fe84 existence-only setup module, line24 | 5 failures,1 pass | 6 passed |
| Remove only the new-URL asset scanner alternative, line30 | 1 missing-pin failure,2 passes | 3 passed |

Every baseline and restore exited zero, each mutant exited one, and no case was pending or todo. These are Vitest assertion/matcher results; recovery cases specifically fail because a promise resolves instead of refusing. The JSON retains every loaded line, whole-file mutant hash, command and raw result, including the primary wrong readiness/pending count and missing JSON pin failures. The working source and scanner were never mutated by the drills.

Both independent agents reviewed the source, all 77 upstream bytes, retained raw hashes and reconstructed whole mutations without rerunning tests. Their exact receipts are linked in the [JSON companion](browser-profile-bootstrap-readiness.json).

Current4dc installed-package and fresh dependency/runtime acceptance remain separate pending qualification. Earlier fe84/cb505 package and automatic-bootstrap proofs retain their original source scope. This document makes no fresh OS/keyring setup, full daemon/model, provider, native input/parity or overall completion claim.
