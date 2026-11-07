# Windows archive guards

Author: Bishop Crockett. Owner: Argellan.com.

This source correction retains archive, analytics and receipt features. It does not qualify a native installation or power-loss behavior. Windows archive data belongs on local fixed NTFS storage; network/device paths, reparse points, untrusted owners and unsafe permissions are refused without changing ACLs or deleting captured rows.

On Windows, new immutable files and missing archive directories use same-parent, no-replace MoveFileExW with MOVEFILE_WRITE_THROUGH. Cross-volume copy, overwrite and reboot scheduling flags are not used. Named segment, manifest and catalog files must pass checked FlushFileBuffers calls and held-handle identity/permission checks before a durable receipt returns. Existing exact-byte validation, ordered item membership and receipt format remain unchanged. A refusal after catalog commit withholds the receipt; an exact retry re-verifies and flushes the same immutable state. It does not replace conflicting content or delete pending sender records.

Windows does not inherit the POSIX directory-fsync implementation. Namespace durability is handled at publication sites, while the directory barrier verifies NTFS and permissions; named-file/catalog flushing occurs explicitly before ACK. Native API refusal always propagates. The NTFS ACL policy trusts the current account, SYSTEM and Administrators, consistent with the existing private-key admission policy. Ancestor read/create rights are distinguished from permissions to replace an existing protected child. Private data/config leaves reject any active allow rule for other principals; unknown ACE forms, null DACLs, changed file identities or handles with reparse attributes are refused.

The sender checks configuration, source database, executable/script and transport configuration paths using a bounded read-only permission collector. No caller command, credential value or ACL mutation is accepted. The receiver and analytics readers independently enforce private path admission. No environment variable disables these guards. POSIX behavior is retained.

Source tests inject every Win32 API and all receiver storage effects. Required follow-on acceptance remains: native API/ABI behavior on the pinned Windows build, real NTFS descriptors and inherited permissions, existing-instance compatibility, crash/power-loss recovery, exact receipt/eviction custody, performance/resource measurements and the current source-bound release gate. Offline mocks or a compiled candidate cannot establish those results.

Primary contracts: [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw), [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers), [ACL information](https://learn.microsoft.com/en-us/windows/win32/secauthz/getting-information-from-an-acl).

The Windows TrustedInstaller SID is accepted as owner only at the fixed-NTFS volume-root ancestor, where all existing unsafe-grant/reparse/ACE checks still apply. It is not added to private-leaf or intermediate-owner trust. Installer defaults use a separately validated USERPROFILE/ARGELLAN/CodexControl-Community path. Both custom destination ancestries are checked before writes; unsafe AppData/workspace ancestors remain refused without ACL repair or automatic data migration.

The bounded permission collector pins its child-only module search path to the existing Windows PowerShell built-in modules. Inherited PowerShell Core module paths cannot redirect or break descriptor collection. No machine/user environment setting, module install or ACL is changed.

OWNER RIGHTS (S-1-3-4) is resolved only to an owner already in the current-user/SYSTEM/Administrators set. This recognizes Python 3.13 private 0700 directories without adding another account or modifying any DACL. Foreign owners, extra broad grants and OWNER RIGHTS attached only to the volume-root owner exception remain refused. Installer-created private directories still require the exact user/SYSTEM descriptor.
