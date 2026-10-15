# Codex managed download factory repair

The final independent review found that Codex discarded the Companion's original onDownload callback when constructing its managed Playwright engine. The engine's safe fallback therefore cancelled ordinary downloads before quarantine could retain them. The Codex launcher now reuses the same createManagedProfileEngine factory as the common daemon.

The regression invokes the actual createHost, its original Companion constructor and createEngine. Only native engine start is stubbed in memory. It dispatches an exact download object through the actual _download method and proves the original handler receives it once, with no fallback cancel or delete. The managed runtime and callback identities are preserved.

Three touched suites pass31cases with zero skips; TypeScript noEmit passes. In a disposable source copy, executable runtime/browser-profile-host.mjs line24 explicitly overwrites onDownload with undefined. The same selected case fails because the original callback receives zero calls. Exact bytes are restored and the same case passes. The JSON receipt prints the changed line and binds red/restored logs and source hashes. Other13host cases are intentionally unselected in that drill; they execute in the full touched run.

This is a factory composition regression, not an actual native download or HOAI release receipt. The final immutable Codex package must use this successor revision. The original c6 package remains historical and is not final acceptance. See the [receipt](browser-profile-download-factory.json).
