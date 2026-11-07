# Read-only observer design

Individually enrolled source machines publish sanitized observations to a private authoritative hub. A bounded SQLite journal assigns ingestion cursors while retaining native source timestamps and identities. Authenticated browsers recover missing pages, preserve frozen replay and render the same event IDs in the observation plane, ribbon, timeline and inspectors.

Explicit worker/subagent and remote-job bindings define relationships. Host utilization is independent of job ownership. Source gaps, orphan results, missing outcomes and unavailable integrations remain visible. Worker execution controls are outside this application. Administration manages only supported instance configuration and enrollment; it does not control Codex work.

Private instance configuration, source credentials, audit/settings stores and journal data remain outside the distributable application. TLS and expected-instance checks precede credentialed collection. See README.md and SECURITY.md for limits.
