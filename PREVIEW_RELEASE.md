# CodexControl Community 0.1.0 — Windows preview 2

Author: Bishop Crockett  
Owner: Argellan.com

[Download the Windows x64 installer](https://github.com/argellan/CodexControl-Community/releases/download/v0.1.0-preview.2/CodexControl-Community-0.1.0-Setup.exe). This release contains the dashboard fixes verified in the Owner's installed Windows app. The original preview remains available under its original tag.

Install on your Windows x64 computer. Node.js, Python and DuckDB are bundled; no Raspberry Pi, remote server, WSL or container is required. Standalone is the default. Change the installation role to Hub or Node in Settings; Linux/Pi computers can report as Nodes. macOS distribution follows later.

Run the installer and keep the local-activity option enabled to observe Codex on this computer. It creates username `admin` with a unique temporary password shown in the app and requires your personal password at first sign-in. Opening a remote dashboard alone does not install its local collector.

## Dashboard fixes

- One Replay / Return to live control in the same position.
- Flow uses the map workspace; the Execution timeline remains available in Ribbon and mobile Activity.
- Measured panel minimums and safe split sizing prevent short or scaled windows from crushing the map. Content reflows or scrolls when it cannot fit.
- Compact desktop filters, inline Fleet search and All lanes, and a slimmer metrics bar. Touch-oriented targets remain larger.
- Stable Sessions, Workers, Subagents and Failures counters preserve their controls during refresh.
- Inspector preserves the expanded Source identity and capture section, scroll position and relevant keyboard focus for the same worker.
- Quota history links new native readings to a stable opaque account identity. Existing unlinked history is retained without assigning it to an unverified account. Account changes invalidate cached graph readings.
- Gold new-input coins, coral output coins and teal cached-input coins, matching meters and labels. Original palette selection, spinning coins, artwork, motion cadence and reduced-motion behavior are retained.
- A graphical Key opens by pointer or keyboard and closes with Escape.
- Committed local numeric-capture diagnostics reach the Usage view; wide tables retain readable columns and accessible horizontal scrolling. A separate Usage-page redesign is outside this release.

Existing role conversions, captured history, archive, Projects/GitHub, Dot, alerts, exports, spending advisory, diagnostics, recovery and administration menus remain available. Credentials, prompts, command arguments, raw output and private reasoning remain excluded from capture.

## Verification and release status

The 170 focused functional tests passed before the final CSS-only metrics-bar compaction. Rendered checks cover the CSS successor, desktop scaling and short heights, larger text, panel-split extremes, keyboard interactions, phone/tablet emulation and primary-touch targets. Native signed-in Windows checks confirm quota history, Inspector persistence, graphical Key behavior, the new palette, live records and rendered token coins. These are functional checks, not a complete performance or physical-device qualification.

Published under the Owner's explicit instruction to defer outstanding release qualification. The current candidate has not passed the full eight-profile performance campaign. An earlier administration-menu candidate measured desktop frame p99 of 34.2 ms against the unchanged 33.4 ms requirement; its experimental repair is excluded. Physical Windows/phone/iPad acceptance, optical latency, soak, native Windows durability/security/update-recovery and Installation-menu ACL checks remain incomplete. No thresholds or recorded failures were changed.

## Existing installations and integrity

This installer supports a fresh installation. It refuses to overwrite existing application and private-instance directories. Do not delete captured data or credentials to work around that protection. The Owner's installation received a separately backed-up application-only update; that does not establish a general in-place installer upgrade qualification.

The base application version remains 0.1.0; the GitHub tag identifies preview 2. The executable is unsigned. Verify the download against the release's `SHA256SUMS.txt`. Bundled runtime licenses and third-party notices are preserved. `RELEASE_PROVENANCE.json` binds this release to the installed candidate, source hashes and installer hash. Private captures, databases, credentials, personal artwork and machine identifiers are excluded.
