# Administration format and forward recovery

Author: Bishop Crockett

Owner: Argellan.com

License: MIT; SPDX-License-Identifier: MIT

The supported recovery operation selects a compatible application runtime while retaining the latest authority in place. It never restores an older security registry, downgrades its fields, issues a credential, stops a process or starts a service. Deployment and real instance operations require separate Owner authorization.

## Format boundary

New administration publications use schema version 2. The reader accepts strictly validated legacy version 1, including the enrollment candidate's complete metadata, without rewriting on read. The next administration mutation publishes version 2. An incomplete modern registry is rejected rather than resetting its generation or discarding receipts.

The state includes viewer roles, scopes, password/key hashes, disabled and expiry status; source current hashes, credential generation and expected identity; durable issuer-owned request receipts; and original audit actions such as replace-source. Generation/current-receipt references must agree. Unsupported versions, unknown authority fields and malformed or incomplete metadata fail closed. Read-only inspection does not seed missing data or repair it.

Unchanged older binaries are unsupported after version 2 publication. A previous application pointer is evidence, not a safe rollback command. Restoring old security bytes can resurrect revoked credentials. The normal managed application-update path also checks format compatibility before changing its pointer.

## Prepare a compatible forward runtime

Use an approved runtime with a complete final RELEASE_MANIFEST.json, passing source-bound performance evidence and the administration-format declaration. Its qualified paths must include the administration reader, format contract and read-only probe. The command checks the package hashes/performance gate, executes the target's probe against the exact current registry, checks instance identity and checksum, and revalidates before publication. A compatible declaration alone is insufficient.

The new runtime must preserve the same authority semantics; it can contain a forward fix for an application regression. Do not use an unchanged old writer or strip metadata to make it load. Test fixtures containing fabricated performance records are not measured qualification evidence and must never be used for a real recovery package.

## Offline preparation command

The instance must already exist, with a valid current registry, hub.json, installation.json and its actual runtime.pid (or gateway-runtime.pid) identity record. The recorded PID must be absent. A live or inaccessible PID, missing initialized authority, a wrong instance, a foreign lock or a symlink/junction causes refusal. Do not create a fictional PID guard or remove a lock based on age.

After the Owner authorizes the named instance and approved runtime, replace all placeholders with absolute paths:

```text
node "<ABSOLUTE_RECOVERY_RUNTIME>/scripts/setup-instance.mjs" "--instance-dir=<ABSOLUTE_PRIVATE_INSTANCE>" "--recover-app=<ABSOLUTE_RECOVERY_RUNTIME>"
```

Run the compatible runtime's setup script, not an older script that lacks this command. Do not pass a password, bearer token or enrollment secret as an argument. There is no force or skip-validation option.

The operation acquires an exclusive application-change lock and the existing offline restore lock. It verifies the current installation, hub configuration, authority and offline guard, prepares a private previous-pointer file, then atomically publishes installation.json. No configuration, history or security bytes are restored. The pointer includes the operation identity, runtime digest and point-in-time authority checksum/revision. That checksum is preparation evidence, not a later restore source or a promise that authority will never change.

Confirmed output is FORWARD_RECOVERY_PREPARED_NOT_STARTED with serviceStarted=false. Starting the service, installation qualification and deployment are separate authorized steps. Repeating preparation for the same selected runtime reconciles the persisted operation and returns alreadyPrepared=true after validating current state again.

## Failure and interruption handling

| Result | Meaning and next action |
|---|---|
| Validation, live PID, foreign lock or unsupported target refusal | No pointer publication is confirmed. Inspect the reported condition; do not bypass it or issue another credential. |
| Staging/disk-full failure before publication | The current authority remains untouched. Owned temporary pointer files and locks are cleaned where the process can do so. Preserve the previous-pointer file as evidence. |
| PUBLICATION_UNCERTAIN | Rename acknowledgement, durability or cleanup could not be confirmed. Inspect installation.json and its applicationChange operation before retrying. Never assume the previous application remains selected and never restore stale authority. A clean repeat can reconcile an already published operation. |
| Abrupt process termination | The pointer is old or new and the security bytes remain in place. Guards may remain intentionally. The next invocation refuses them; it never steals a lease. |
| Corrupt or missing current authority | Recovery refuses initialization/repair. Preserve evidence and escalate for a separately authorized security-state recovery procedure. |

For stale guards after a crash, an authorized operator must establish the exact instance, operation, recorded process identity and actual offline state, preserve guard evidence and obtain approval for cleanup/reconciliation. This command does not automatically reclaim stale locks, kill processes, restore a security snapshot or restart a service. A PID may have been reused; never kill or remove another owner's resource.

The Admin backup covers configuration.json and history.sqlite, not administration.json. Its existing restore flow leaves current security in place. It is not a security-registry backup. Restoring older history/configuration must retain current revocations, hashes, scopes, receipts and generations; never substitute pre-upgrade authority.

## Qualification boundaries

Automated synthetic checks exercise legacy reads, exact older-reader refusal, current authority and session decisions, generation-specific collector reporting, receipt replay, target-probe admission, pointer publication, ordinary failures, abrupt before/after publication and fresh-process HTTP handling. They do not establish physical installation, actual service restart, OS power-loss durability or measured performance on this source. A provisional bundle is not deployable. Final packaging and deployment remain blocked until the repository performance gate and applicable live/physical acceptance pass.
