> **Windows Community preview 3:** [Download the updated installer](https://github.com/argellan/CodexControl-Community/releases/download/v0.1.0-preview.3/CodexControl-Community-0.1.0-Setup.exe) · [Fixes, installation and verification status](https://github.com/argellan/CodexControl-Community/blob/main/PREVIEW_RELEASE.md).

# CodexControl Community for Windows — ARGELLAN

**Already installed?** Run the new installer and choose **Update Community**. Your history, settings and existing password are retained. [Windows upgrade guide](https://github.com/argellan/CodexControl-Community/blob/main/WINDOWS_UPGRADE.md).

CodexControl runs on your own computer. Install the Community Windows EXE. It starts in Standalone mode. Change its role later in Settings without reinstalling:

- **Hub**: run the dashboard and local observation on your Windows desktop, and manage Nodes on your network.
- **Node**: observe this computer and report to the Hub you explicitly pair with.
- **Standalone** (default): observe this computer independently.

The Hub belongs on a Windows desktop; Mac distribution will follow later. Raspberry Pi, Linux and Windows Server computers act as Nodes. They are not Hub deployment targets. Configure and pair Nodes through the Hub's Settings. Discovery never authorizes a device; pairing requires explicit identity confirmation.

The Windows installer bundles Node.js, Python, SQLite and DuckDB. Its local dashboard, captured history, archive and analytics require no ARGELLAN server, Raspberry Pi, NAS, WSL, container or system runtime installation. Captured data stays in the user's private instance directory outside the application. Optional GitHub and account connections use the user's own authorization.

Observe local Codex metadata during installation to see this computer's activity. The selection can be turned off. Prompts, command arguments, raw output, credentials and private reasoning remain excluded. Initial sign-in information is saved privately in the instance folder. Never share that file or put its credential into a URL.

The dashboard retains Flow/Ribbon, spinning token coins, quota/history, Dot, Projects/GitHub, alerts, exports, spending advisory, diagnostics and recovery. Preserve private data and pending delivery whenever updating or uninstalling. A Node delivery acknowledgement is not an archive receipt.

This source is a Windows release candidate under verification. Source reconciliation, native installation and functional checks are distinct from the unchanged performance, security and physical-device release gates. See docs/CHECKPOINT.md for exact current evidence. An unsigned test EXE is not a qualified public release.

Author: Bishop Crockett. Owner: Argellan.com. First-party license: MIT. Preserve LICENSE and THIRD_PARTY_NOTICES.md and all bundled runtime notices.
