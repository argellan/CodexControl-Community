# Updating CodexControl Community on Windows

Author: Bishop Crockett  
Owner: Argellan.com

Run the downloaded Windows installer while signed into the same Windows account that owns CodexControl. It detects the normal existing installation and offers **Update Community**. Keep **Open CodexControl after installation** selected to reopen the dashboard. Existing collection choices, installation role, accounts, personal password, paired devices and presentation settings are kept. There are no tokens to generate or scripts to run.

The updater verifies the new payload and existing installation, closes only that installation through its graceful shutdown path, verifies an offline private backup, checks the new administration reader against the existing accounts, then promotes the staged application. The previous application and private snapshot remain under the installation home's private `maintenance-backups` directory. Unmanaged application additions are carried forward; conflicts or modified tracked files stop the update without silently discarding them.

The private instance stays at its existing path. Upgrade never runs first-time initialization or password provisioning. If the update fails, the previous application is restored. It does not restore an older private snapshot over records captured by a replacement runtime. If interrupted, run the downloaded installer again; its transaction journal identifies the exact installation and recovers the application safely. Backups are retained for review.

A newly started replacement must acknowledge operational readiness before the updater commits success. If an owned process cannot stop safely, or startup/compatibility cannot be established, the updater stops and retains the prior application and private data. Close CodexControl normally, then run the installer again. It never force-terminates the application or signals unrelated processes.

The supported automatic path is the per-user Windows installation on fixed local NTFS, with active data inside its private instance. Custom network locations, links/junctions, conflicting maintenance operations and incompatible administration formats are refused while existing files remain intact. External archive locations are not relocated or deleted. The installer does not silently migrate an unsupported data format.

The installer remains unsigned and release qualification status is documented in PREVIEW_RELEASE.md. Verify the installer download using the release checksums. Physical power-loss testing and a complete Windows security/durability qualification remain separate from the native synthetic upgrade tests.
