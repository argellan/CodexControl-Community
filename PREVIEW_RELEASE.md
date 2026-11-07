# CodexControl Community 0.1.0 — Windows preview

Author: Bishop Crockett  
Owner: Argellan.com

Install on your Windows x64 computer. Node.js, Python and DuckDB are bundled; no Raspberry Pi, remote server, WSL or container is required. Standalone is the default. Change the installation role to Hub or Node in Settings; Linux/Pi computers can report as Nodes. macOS distribution follows later.

Download `CodexControl-Community-0.1.0-Setup.exe` from this repository's GitHub Releases page. Run the installer and keep the local-activity option enabled to observe Codex on this computer. It creates username `admin` with a unique temporary password shown in the app and requires your personal password at first sign-in. Opening a remote dashboard alone does not install its local collector.

The reviewed administration menus include the account table and focused account editor. Existing dashboard features, token coins, full captured history, role conversions, quota, project/GitHub, Dot artwork, exports and recovery functionality remain in the source. Prompts, command arguments, raw output and private reasoning remain excluded from capture.

## Release status

Published under the Owner's explicit instruction to defer outstanding qualification blockers. This is a preview and is not performance-qualified. The reviewed source measured desktop frame p99 of 34.2 ms against the unchanged 33.4 ms requirement. The experimental repair is excluded. The full eight-profile campaign and physical Windows/phone/iPad, optical latency, soak, native Windows durability/security/update-recovery and Installation-menu ACL checks remain incomplete. Their thresholds have not been changed or represented as passed.

The installer supports a fresh installation; it preserves an existing installation by refusing to overwrite its application or instance directories. Keep existing captured data and credentials when updating. The Owner's existing local installation received a separate backed-up application-only menu update; that does not establish a general installer upgrade qualification.

The executable is unsigned. Verify it against `SHA256SUMS.txt`. Bundled runtime notices and third-party licenses are preserved. Exact reviewed source and installer hashes are in `RELEASE_PROVENANCE.json`.

Development and detailed installation documentation follow in the original project README and release directory. Historical preparation/qualification documents retain their original dates and verdicts; this release authorization does not rewrite them.
