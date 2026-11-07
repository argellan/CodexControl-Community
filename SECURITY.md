# Security and responsible reporting
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Security review is evidence tied to an exact source version, not a security certification. Use the repository's **Security → Advisories → Report a vulnerability** channel when available. If private reporting is unavailable, ask the maintainer to arrange a private channel without including exploit details, credentials or private telemetry. Do not send data to a guessed address or publish exploit details in a public issue.

Threat boundaries: a viewer may inspect only its configured scope; an instance administrator may manage supported instance settings and enrollments; each collector authenticates only as its own source. Those capabilities do not authorize Codex execution. The hub journal contains sanitized project, machine and activity metadata and should be treated as private operational data. TLS protects transport; it does not establish that a source's reported activity is independently true.

Use a fixed HTTPS origin for network access, trusted certificates, private file permissions and separate credentials. Expected instance and machine identity must be checked before a collector sends an enrollment secret. Do not add permissive CORS, disable TLS verification, expose SQLite/configuration files, or publish the private instance directory. Avoid forwarding bearer credentials through unrelated reverse proxies.

The package builder checks an explicit file allowlist, forbidden operational artifacts, private endpoint/user-path patterns and literal credential/private-key patterns. Automated checks can miss unknown secrets. Independent human review remains required before any publication. Checksums are integrity records, not signatures. T3 notices and the font license must remain with redistributed code/assets.
