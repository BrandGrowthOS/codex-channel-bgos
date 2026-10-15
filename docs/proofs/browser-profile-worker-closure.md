# Committed profile worker closure

The Codex runtime copier now includes every strict bounded filename and exact SHA-256 declared by the committed shared profile-core inventory. This covers encryption and journal workers launched through path.join rather than a static import. It rejects missing files, path traversal, excessive inventories and mismatched source pins. Each inventory is processed once; all bytes still come from the selected Git commit.

Two focused suites passed five cases with zero skips, and tsc --noEmit exited zero. The new executable fixture creates an isolated committed source repository, copies the actual vendor CLI, packages a worker reachable only through a constructed filename, then runs that real worker from the resulting private package. Its negative case refuses malformed inventories. Historical .tmp copies were excluded from the reported exact run.

Two isolated copy mutations printed executable lines, failed with direct assertions, restored exact bytes and passed the same selected cases. Omitting the manifest dependency queue loses the real worker. Omitting the declared hash comparison accepts a mismatched core. Working source stayed unchanged. The [receipt](browser-profile-worker-closure.json) retains hashes and red/restore outcomes. This synthetic dependency fixture is separate from final fresh installed companion acceptance.
