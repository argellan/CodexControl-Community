# Private NAS archive receiver container

This service accepts immutable usage batches over key-only SSH. It does not run
Codex, call a model, collect prompts, expose a web endpoint or share a mission
database. The existing NAS SSH service and account memberships stay unchanged.

Use a supported official Python 3.12 image rather than the NAS appliance's Python
runtime. Build from an **allowlisted release context**, never the private working
directory: sending a Docker build context uploads its contents to the daemon.
The context needs the receiver and the four files in `deploy/archive-container`.
Record the resolved base-image digest, final image ID, package versions and file
hashes in the private deployment evidence. An operator may override `PYTHON_IMAGE`
with the reviewed official image digest when building.

## Storage and identity

| Mount | Storage | Permissions and purpose |
|---|---|---|
| `/archive` | Bind only a newly created private leaf in the selected NAS archive folder | Receiver UID/GID, mode 0700; closed immutable gzip segments and manifests |
| `/catalog` | Private Docker **local named volume** | Receiver UID/GID, mode 0700; active SQLite catalog, on the same NAS host as its engine |
| `/keys` | Separate private Docker **local named volume** | Root, mode 0700; persistent SSH host private key, never in the image or exported files |
| `/config` | Private Docker **local named volume**, mounted read-only at runtime | Receiver UID/GID, directory mode 0700; `receiver.json` and `authorized_keys` files mode 0600 |
| `/run`, `/tmp` | Size-limited tmpfs | Ephemeral daemon state; no archived records |

The public build defaults are `PUID=1000` and `PGID=1000`. Set them at image build
time to the intended dedicated identity. They are immutable account parameters;
runtime disagreement fails preflight. No host account is added to an administrator
group or enabled for host SSH. The container's `codex` account has no usable
password; authentication is public-key only.

The NAS shared folder may have broad appliance ACL/mode semantics. Do not change
the shared parent to satisfy the receiver. Bind only the private leaf directly to
`/archive`, so its container ancestors are controlled by the image. Do not put the
active catalog in that shared folder or mount an active database across SMB/NFS.
On Synology, inherited ACLs can make a leaf appear as mode 0777 inside a container
even after a host-side `chmod 0700`. Qualify ownership and permissions **inside
the container**; the entrypoint must refuse a leaf that is still accessible to
others. Any ACL correction is limited to the newly created, empty, identified
archive leaf: preserve its prior ACL, verify its exact path and emptiness, and
independently confirm both shared-parent ACLs remain byte-for-byte unchanged.
Never remove a parent ACL, recurse into existing data, or weaken the preflight.

Keep receiver configuration and the authorized public key in the private local
configuration volume rather than the shared archive tree. Two individually
read-only file binds are also supported if the same ownership, permissions and
private-local-storage requirements are met.

Example private receiver configuration:

```json
{
  "archiveDirectory": "/archive",
  "catalogDirectory": "/catalog",
  "receiverId": "REPLACE_WITH_PRIVATE_RECEIVER_UUID"
}
```

Generate a new receiver UUID in the private deployment configuration and pin it
in the Pi sender. Do not export deployment UUIDs, private paths, actual LAN
addresses, credentials or key material into the public application.

The dedicated public-key line must use exactly this option order:

```text
restrict,from="OBSERVED_SOURCE_ADDRESS",command="/usr/local/bin/codex-archive-command" ssh-ed25519 PUBLIC_KEY_BLOB optional-comment
```

Set `ARCHIVE_SOURCE` to the same exact source IP or strict CIDR. The entrypoint
rejects additional keys, a changed forced command, or an unrestricted key. The
only accepted SSH original command is the literal `archive`. Shell, SFTP,
forwarding, TTY and arbitrary receiver/query arguments are refused. Query and
rebuild maintenance use administrator-controlled local `docker exec` instead.

Observe the source address in the actual SSH connection before declaring this a
Pi-address restriction. Some Docker userland proxies replace the original client
address with a bridge proxy address. In that case the `from=` entry may pin only
the verified proxy address, and **does not enforce the original Pi IP**. The
dedicated Pi ingestion key remains the authenticated client identity; strict
host-key pins authenticate the receiver. Record the source-translation limit
explicitly instead of changing the NAS daemon or global firewall to hide it.

## Build and one-time volume initialization

These are generic Linux host templates. Resolve and verify the actual paths,
identity, bind address, free port and image on the authorized NAS first. Existing
volumes/container names require reconciliation, not replacement. Do not restart
the Docker engine or inspect unrelated workloads.

```sh
PUID=1000
PGID=1000
IMAGE=codexcontrol-archive:reviewed
docker build --build-arg PUID="$PUID" --build-arg PGID="$PGID" \
  -f deploy/archive-container/Dockerfile -t "$IMAGE" ALLOWLISTED_RELEASE_CONTEXT
docker volume create --label application=codexcontrol-archive codexcontrol-archive-keys
docker volume create --label application=codexcontrol-archive codexcontrol-archive-catalog
docker volume create --label application=codexcontrol-archive codexcontrol-archive-config
docker run --rm --network none --read-only \
  --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true \
  --env PUID="$PUID" --env PGID="$PGID" \
  --mount type=volume,src=codexcontrol-archive-keys,dst=/keys \
  --mount type=volume,src=codexcontrol-archive-catalog,dst=/catalog \
  --mount type=volume,src=codexcontrol-archive-config,dst=/config \
  --entrypoint /bin/sh "$IMAGE" -eu -c \
  'chown 0:0 /keys; chmod 0700 /keys; chown "$PUID:$PGID" /catalog /config; chmod 0700 /catalog /config'
```

Prepare only the selected new archive leaf with the ownership/modes above, then
populate `receiver.json` and `authorized_keys` in the local configuration volume
as the dedicated UID, mode 0600. The configuration volume is writable only during
this controlled initialization; the service mounts it read-only. Do not
recursively chown or chmod the shared folder. The one-time helper has `CHOWN`;
the long-running container does not.

## Bounded receiver runtime

Set the following variables in the private deployment process: `NAS_LAN_ADDRESS`,
`OBSERVED_SOURCE_ADDRESS`, `ARCHIVE_LEAF`, and the
reviewed immutable `IMAGE`. The paths are absolute, inspected, non-symlink paths.

```sh
docker run -d --name codexcontrol-archive --restart unless-stopped \
  --read-only --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add SYS_CHROOT --cap-add KILL \
  --memory 256m --memory-swap 256m --cpu-shares 128 \
  --stop-timeout 30 \
  --tmpfs /run:rw,noexec,nosuid,nodev,size=16m,mode=0755 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --publish "${NAS_LAN_ADDRESS}:2224:2222/tcp" \
  --env PUID="$PUID" --env PGID="$PGID" --env ARCHIVE_SOURCE="$OBSERVED_SOURCE_ADDRESS" \
  --mount type=volume,src=codexcontrol-archive-keys,dst=/keys \
  --mount type=volume,src=codexcontrol-archive-catalog,dst=/catalog \
  --mount type=volume,src=codexcontrol-archive-config,dst=/config,readonly \
  --mount "type=bind,src=${ARCHIVE_LEAF},dst=/archive" \
  --log-driver json-file --log-opt max-size=5m --log-opt max-file=2 \
  "$IMAGE"
```

The daemon starts as container root only to handle SSH identity separation, then
runs each receiver session as `codex`. Four capabilities support its UID/GID and
privilege-separation chroot transitions plus cross-UID SSH child cleanup (`KILL`).
No privileged mode, Docker socket, host
PID namespace, host network, host root filesystem or extra device is mounted.
Docker's standard seccomp profile remains enabled.

**Resource qualification limit:** some NAS kernels lack CPU CFS quota and PID
controllers. Docker can reject `--cpus` or silently omit an unsupported PID limit;
the command above therefore uses `--cpu-shares 128` as **relative scheduling
priority, not a hard CPU cap**, and makes no PID-cap claim. On a host where both
controllers are independently verified, `--cpus 0.25 --pids-limit 64` can provide
additional controls. Verify effective runtime/cgroup readback rather than treating
accepted command-line flags as enforcement. Keep transfers sequential, bound each
batch and retry cycle, and measure actual CPU, memory and process counts. These
application bounds do not replace unsupported kernel quotas. Record the effective
256 MiB memory limit separately from CPU/PID limits and disclose any absent cap.

**Network qualification limit:** this bridge/published-port template restricts
the listener to the selected LAN address and the key to its observed source, which
may be a Docker proxy rather than the original Pi. It does
not establish an OS-level egress-denial policy. The receiver has no outbound code
paths or provider credentials. Do not describe runtime egress as blocked unless
an independently verified standard network/firewall policy is added. Do not
change global NAS firewall policies or Docker daemon settings for this service.

## Host-key pin and acceptance

After startup, read `/keys/ssh_host_ed25519_key.pub` through the **existing pinned
NAS administrator channel** with a local Docker operation. Record its SHA-256
fingerprint and install that public host key in the Pi sender's private known-hosts
file. Use strict host-key checking. Do not bootstrap trust with an unverified
network `ssh-keyscan`, TOFU, disabled verification or the NAS administrator's key
as the Pi ingestion credential.

Qualification must demonstrate all of the following before enabling eviction:

- Exact container/image/config/receiver identity and the expected mounts, UID/GID,
  effective limits, capability set, read-only root and no-new-privileges policy;
  configuration volume is read-only and the archive leaf is private inside the
  container, with parent ACLs unchanged.
- Actual strict-pinned Pi-to-receiver SSH with the dedicated ingestion key;
  shell, SFTP, wrong original commands and forwarding denied. Record the observed
  source and explicitly disclose when the original Pi address is hidden by a proxy.
- NAS filesystem hard-link publication, file and directory fsync, hash/manifests,
  durable catalog commit, exact-version receipt and byte-exact query readback.
- Lost-ACK replay and differently encoded gzip retries remain idempotent; sender
  keeps records until their exact version has a verified durable receipt.
- The same segments, host key and catalog survive an **owned-container-only**
  restart. A corrupt/missing segment fails verification and cannot acknowledge.
- Backlog, outage and storage-pressure indicators remain visible. Resource use is
  measured with the effective memory limit and CPU scheduling priority; unsupported
  hard CPU/PID caps remain explicitly absent. No Pi or model work is run on the NAS
  receiver.

Image/config source inspection alone does not establish these runtime results.

## Verify, export and rebuild

The commands below operate only on this container and run as the dedicated UID.
Quiesce ingestion before catalog reconstruction. Retain verified cold segments
and manifests independently; the catalog is a rebuildable index, not the only
copy of the history. Never replace the archive with aggregates.

```sh
docker exec --user "$PUID:$PGID" codexcontrol-archive \
  python3 -I -B /opt/codexcontrol/archive-receiver.py --config /config/receiver.json --status
docker exec --user "$PUID:$PGID" codexcontrol-archive \
  python3 -I -B /opt/codexcontrol/archive-receiver.py --config /config/receiver.json --verify
docker exec --user "$PUID:$PGID" codexcontrol-archive \
  python3 -I -B /opt/codexcontrol/archive-receiver.py --config /config/receiver.json \
  --query --host HOST_ID --project PROJECT_ID --after 0 --limit 1000 > usage-page.jsonl
docker exec --user "$PUID:$PGID" codexcontrol-archive \
  python3 -I -B /opt/codexcontrol/archive-receiver.py --config /config/receiver.json --rebuild
```

Query stdout is exact canonical NDJSON; stderr contains page metadata including
the next cursor. Repeat with that cursor for the full export. `--from-ms` and
`--to-ms` filter capture/recording time, not provider generation time. Rebuilding
can change catalog cursors; start a new export after reconstruction. Recovery
must verify every immutable segment/manifest before accepting the rebuilt index.
Keep verified backup copies of closed segments and manifests on independent
storage; RAID and an index rebuild do not replace backup custody.

References: [Docker runtime security and resource options](https://docs.docker.com/engine/containers/run/),
[Docker volumes](https://docs.docker.com/engine/storage/volumes/),
[tmpfs storage](https://docs.docker.com/engine/storage/tmpfs/),
[published port behavior](https://docs.docker.com/engine/network/port-publishing/),
and [OpenSSH daemon restrictions](https://man.openbsd.org/sshd_config).
