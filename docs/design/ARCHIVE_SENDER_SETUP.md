# Usage archive sender: user-service deployment example
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

**Status: deployment example only. The receiver target is not configured, and neither unit is enabled by this guide.** No credentials, server addresses or production enrollment are included. Complete the receiver/storage requirements in [USAGE_ARCHIVE.md](USAGE_ARCHIVE.md) before using these examples.

The Pi keeps its active `history.sqlite`, SQLite journal files and archive outbox on its local disk. The separate receiver keeps its active catalog/database on that receiver's local disk. A NAS may hold only closed immutable segments and verified backup snapshots; do not place either live SQLite database across SMB or NFS.

The archive sender is a separate, bounded process. It does not run model work or control Codex workers. The examples use a systemd **user** service, under the same OS account that owns the hub's private data. They do not grant access to another application's databases or mission services.

## Prerequisites

1. Provision the approved archive receiver, its dedicated OS account, persistent storage and stable receiver UUID using the receiver specification. Qualify its fsync/atomic publication behavior and any NAS mount pin before trusting receipts.
2. Create a dedicated SSH identity for this sender. Enroll only its public key on the receiver, with a forced receiver command. Never reuse an administrator key or place private-key bytes in the JSON, unit, environment, logs or repository.
3. Verify the receiver's SSH host-key fingerprint through an independent trusted channel, then write the exact hostname/port entry into the sender's dedicated `known_hosts` file. An unverified `ssh-keyscan` result is not a trust decision. Do not disable host-key checking.
4. Install the application and bundled Node runtime locally at the paths below, with the R14 archive schema present and a current verified backup. Confirm the configured `history.sqlite` belongs to this exact hub.
5. Confirm the user service manager supports the requested memory/CPU controllers and scheduling controls. The examples do not modify host cgroup delegation, user namespaces or login persistence automatically.

The receiver's `authorized_keys` entry should restrict the dedicated public key to the receiver program. This is a template, not a usable key:

```text
restrict,command="/usr/bin/python3 /opt/codexcontrol/archive/archive-receiver.py --config /etc/codexcontrol-archive/receiver.json" ssh-ed25519 REPLACE_WITH_DEDICATED_PUBLIC_KEY
```

The sender requests the literal SSH command `archive`; the forced command ignores that word and launches the receiver with its private configuration. The receiver account must not gain an interactive shell, forwarding or general administrator access through this key. Validate the complete restriction on the selected SSH server. Receiver configuration and catalog/mount requirements are specified in [USAGE_ARCHIVE.md](USAGE_ARCHIVE.md).

## Private sender configuration

Create the configuration at `$HOME/.config/codex-control/archive.json` on the Pi, owned by the hub's OS account and mode `0600`. The JSON below uses generic `/srv/codexcontrol` example paths; replace them with the actual private absolute paths for the instance addressed by the unit's `%h` layout. JSON does not expand `$HOME`, `~` or systemd `%h` specifiers. Replace the reserved example hostname and obtain the actual UUID from the approved receiver.

```json
{
  "version": 1,
  "database": "/srv/codexcontrol/data/history.sqlite",
  "receiverId": "00000000-0000-4000-8000-000000000000",
  "ssh": {
    "executable": "/usr/bin/ssh",
    "host": "archive-receiver.example.invalid",
    "port": 22,
    "user": "codexarchive",
    "identityFile": "/srv/codexcontrol/config/archive_ed25519",
    "knownHostsFile": "/srv/codexcontrol/config/archive-known_hosts"
  },
  "maxBatches": 4,
  "maxRecords": 1000,
  "maxBytes": 2097152,
  "bootstrapLimit": 1000,
  "timeoutMs": 20000
}
```

The required fields are `version`, `database`, `receiverId` and `ssh`. Unknown fields are refused. The receiver UUID is pinned after first configuration; moving custody to a different receiver requires an explicit migration, not changing a hostname or UUID until an error disappears.

| Setting | Default | Accepted bound |
|---|---:|---:|
| `maxBatches` | 4 | 1–32 per invocation; larger catch-up runs are opt-in |
| `maxRecords` | 1000 | 1–1000 per batch |
| `maxBytes` | 2097152 | 1024–2097152 raw NDJSON bytes per batch |
| `bootstrapLimit` | 1000 | 1–1000 legacy rows seeded per pass |
| `timeoutMs` | 20000 | 50–30000 per transport attempt |

The configuration, identity and database must be ordinary private files, with no symlink traversal. The sender checks POSIX ownership and permissions. Keep the SQLite data directory private, since SQLite may create WAL/SHM files next to the database. The known-hosts file and SSH executable must not be writable by other users. Parent directories must remain under trusted administrative ownership.

Richer V2 backfills can use a larger explicitly configured batch count without changing the 110-second run deadline, per-transfer timeout, exact ACK checks or service resource limits. Measure the chosen host before increasing it. After a committed ACK the sender may reclaim at most256 free SQLite pages; this applies only to databases already using incremental auto-vacuum. It never enables auto-vacuum or performs a full database rewrite. Existing non-vacuum databases require separate offline, backed-up maintenance. Hot V2 samples target50,000 rows, with bounded pressure sweeps selecting only exactly acknowledged records. Pending records remain even above that target.

SSH runs noninteractively with only the dedicated identity and pinned known-hosts file. User SSH configuration, agent identities, connection multiplexing, forwarding, password prompts and remote local commands are disabled. No private-key bytes are loaded into application settings or browser responses.

## Unit behavior and resource limits

The sample files are [archive-sender.service](../../deploy/archive-sender.service) and [archive-sender.timer](../../deploy/archive-sender.timer). Install them as user units only after target configuration and a successful manual custody check.

The timer activates once per minute. A running service is not restarted or duplicated by another timer tick. `Persistent=true` provides a catch-up activation after the timer was inactive, rather than launching one process for every missed minute. A long or failed invocation can therefore reduce effective throughput. [systemd timer documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)

The service is `Type=oneshot` with no automatic restart loop, a 192 MiB memory ceiling, 10% of one CPU quota, lower process priority and idle I/O scheduling. `UMask=0077` and `NoNewPrivileges=yes` apply to the process. These resource limits depend on host controller support; inspect effective properties on the actual Pi before calling them verified.

Both `RuntimeMaxSec=120` and `TimeoutStartSec=120` are present. **`TimeoutStartSec` supplies the actual oneshot deadline**; `RuntimeMaxSec` alone does not limit oneshot activation. A ten-second stop timeout allows cancellation and lock cleanup before systemd terminates remaining child processes. A forced termination can leave the durable batch pending, which is safe to retry. [systemd service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)

The generic unit intentionally omits filesystem namespace settings. Per-user `ProtectSystem`/`ReadWritePaths` restrictions require host-specific namespace support, commonly with `PrivateUsers`; blindly adding them can prevent the service from starting. After qualifying that support on the selected host, an administrator can add a tested drop-in with `PrivateUsers=yes`, `ProtectSystem=strict` and `ReadWritePaths=%h/.local/share/codex-control/data`, adjusted to the exact local data directory. Prove SSH/key access, SQLite WAL/SHM creation, lock creation, ACK commit and a normal retry before enabling such a drop-in. Do not weaken host namespace policy just to make the example run. [systemd execution documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

## Installation and verification sequence

These commands are examples for the approved Linux account **after** provisioning the real receiver and private configuration. They have not been run by this guide. They do not create a configuration or import host keys.

```bash
install -d -m 700 "$HOME/.config/systemd/user"
install -m 600 "$HOME/.local/share/codex-control/app/deploy/archive-sender.service" "$HOME/.config/systemd/user/archive-sender.service"
install -m 600 "$HOME/.local/share/codex-control/app/deploy/archive-sender.timer" "$HOME/.config/systemd/user/archive-sender.timer"
systemd-analyze --user verify "$HOME/.config/systemd/user/archive-sender.service" "$HOME/.config/systemd/user/archive-sender.timer"
systemctl --user daemon-reload
```

Run one bounded foreground attempt first:

```bash
"$HOME/.local/share/codex-control/runtime/bin/node" "$HOME/.local/share/codex-control/app/scripts/archive-usage.mjs" --config "$HOME/.config/codex-control/archive.json"
```

Independently verify the receiver's immutable segment, manifest and catalog entry against the exact batch's raw hash, ordered item IDs and count. Confirm the Pi committed the durable receipt and that a duplicate retry neither duplicates history nor grants pruning for a newer unacknowledged record version. Check receiver-unavailable and wrong-receipt cases before accepting the deployment.

When that succeeds, start the service once under systemd and inspect its effective settings:

```bash
systemctl --user start archive-sender.service
systemctl --user status archive-sender.service
systemctl --user show archive-sender.service -p Result -p ExecMainStatus -p MemoryMax -p CPUQuotaPerSecUSec -p Nice -p IOSchedulingClass -p NoNewPrivileges -p TimeoutStartUSec
journalctl --user -u archive-sender.service -n 20 --no-pager
```

Enable scheduling only after those checks pass for the approved target:

```bash
systemctl --user enable --now archive-sender.timer
systemctl --user list-timers archive-sender.timer
```

A user timer runs only while its user service manager exists. For unattended boot operation, an administrator must deliberately configure and verify lingering for the approved account, or provide an equivalent supported service arrangement. This sample does not change login policy or enable lingering.

## Pending records, recovery and storage pressure

The default budget is at most 4,000 row revisions per invocation, not 4,000 model events. A usage observation can update multiple captured tables. An outage, bootstrap backlog, CPU throttling or sustained capture above the transport budget can grow the queue. Watch pending record count, oldest pending age, last attempt, last successful ACK, error code, free local disk and free archive storage.

The sender preserves its frozen batch across failed or lost ACKs. It verifies the pinned receiver, authoritative raw hash, exact ordered membership, count and durable status before committing ACKs locally. A valid existing segment can use another gzip encoding of the same raw content; the stored compressed hash describes that retained file, while the received compressed hash, when supplied, must match this transmission.

Unavailable transport, invalid receipts or receiver identity changes do not permit deletion. Pi retention targets remain hot-cache targets; the exact current record version must have a verified archive receipt before eviction. Pending history is kept even above a cache target. Restore the archive path or plan additional capacity before the local disk fills. Do not clear the outbox, weaken receipt checks, reset pinned identities or delete records to silence an alert.

Command output contains fixed status/error codes and bounded counts, not raw SSH diagnostics or key material. A syntactically successful one-shot attempt does not by itself prove all history has drained: inspect backlog and bootstrap completion as well as the exit status.

## Offline restore coordination

Before a planned restore, verify existing custody and drain pending work where possible. Then stop both the timer and its current service before stopping the hub using the normal offline-restore procedure:

```bash
systemctl --user stop archive-sender.timer
systemctl --user stop archive-sender.service
systemctl --user is-active archive-sender.timer archive-sender.service
```

`is-active` should report both units inactive and return a nonzero exit status. Do not launch the sender manually during restore. The restore program additionally takes the same per-database archive lock used by the pump and holds it across custody verification, replacement and cleanup. That lock prevents an ACK committing to a database being replaced; stopping only the timer would not stop an already running sender.

The lock is released automatically on normal completion. A dead same-user PID lock can recover; malformed locks fail closed. Investigate an unexpected lock instead of deleting one while any sender or restore process might still be alive. Follow the restore program's custody refusal when newer pending data would be lost.

After restore and its integrity/custody checks pass, restart the approved hub, run and inspect one archive attempt, and resume the timer only if it was enabled before maintenance:

```bash
systemctl --user start archive-sender.service
systemctl --user status archive-sender.service
systemctl --user start archive-sender.timer
```

No automatic history deletion, receiver enrollment, NAS setup, Timescale migration or network operation is performed by these example files.
