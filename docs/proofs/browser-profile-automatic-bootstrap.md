# Automatic default Chromium provisioning qualification

The installed Codex package's real default ensureBrowser resolver downloaded its pinned Chromium into an initially empty normal user cache in 9.15 seconds. A second call reused that cache without a second install log. No custom bundle, spawn implementation, executable or cache override was supplied.

This exact run uses Codex commit 6a6b7cc13f4a9137792d480a6444384f0dc9ae4b and common commit 7106437b6ed128a2fd2f9f5fd7339cd756588e1a. The shipped bootstrap source is SHA256 afd690386d5edaa82fdfbc1b35203e50a74abd038249405452c706b885515f92. The automatic download resolved Chromium 156.0.8078.4 at the default private HOME cache path, with exact binary SHA256 377a9fc07b495c3b8d0ab8ec1fdfd153641759f9756fea34d8dfce4de82f5025.

Three observed installer child PID/start identities were gone after completion. The owned install lock was absent, the private HOME was removed, and Docker inventory positively confirmed container absence without a forced stop. Chromium was separately invoked with --version and exited zero. No browser session or context was launched; this is the meaning of the raw noBrowserLaunch flag.

The disposable Linux image already provides patched Node 22.23.3 and compatible OS dependencies. The fixture explicitly supplies user 1000 and a private 2 GiB tmpfs for HOME and temporary download files. This is automatic browser provisioning under those prerequisites, without manual CLI prewarming. It does not qualify fresh OS installation, OS dependency automation, Secret Service setup, full cold host/session readiness latency, enrollment or final HOAI composition. The manually prewarmed composed package fixture is a separate proof.

The unchanged bootstrap source remains pinned here if a later backup timer fix supersedes the common runtime. This receipt must not be relabelled as evidence from that later image.

See [the exact scripts, scope and raw hashes](browser-profile-automatic-bootstrap.json).
