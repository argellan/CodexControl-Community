# Author: Bishop Crockett
# Owner: Argellan.com
# SPDX-License-Identifier: MIT
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('windows_archive_guard',Path(__file__).parents[1]/'scripts'/'archive-windows.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class FakeApi:
    current_sid='S-1-5-21-123'
    def __init__(self): self.events=[];self.fail_flush=False;self.fail_move=False;self.changed=False;self.identities={}
    def open(self,path,write=False,rename=False):self.events.append(('open',str(path),write,rename));return str(path)
    def describe(self,handle):
        return dict(owner=self.current_sid,allows=[(self.current_sid,0x1f01ff,0)],filesystem='NTFS',fixed=True,reparse=False,identity=(7,self.identities.get(handle,hash(handle)) if not self.changed else 0))
    def close(self,handle):self.events.append(('close',handle))
    def flush(self,handle):
        self.events.append(('flush',handle))
        if self.fail_flush:raise OSError('TEST_ONLY flush refusal')
    def move(self,source,target,flags):
        self.events.append(('move',str(source),str(target),flags))
        if self.fail_move:raise OSError('TEST_ONLY move refusal')
        self.identities[str(target)]=self.identities.get(str(source),hash(str(source)))
class GuardTests(unittest.TestCase):
    def test_guard_refusal_uses_existing_bounded_os_error_boundary(self):
        self.assertTrue(issubclass(m.WindowsArchiveRefusal,OSError))
    def setUp(self):self.api=FakeApi();self.guard=m.WindowsArchiveGuard(self.api)
    def info(self,**extra):
        d=self.api.describe('TEST_ONLY');d.update(extra);return d
    def test_private_acl_accepts_only_trusted_principals(self):
        m.validate_descriptor(self.info(),self.api.current_sid,private=True)
        with self.assertRaises(m.WindowsArchiveRefusal):m.validate_descriptor(self.info(allows=[('S-1-1-0',1,0)]),self.api.current_sid,private=True)
    def test_ancestor_read_and_child_create_are_distinct_from_replace(self):
        m.validate_descriptor(self.info(allows=[('S-1-1-0',0x1200af,0)]),self.api.current_sid,private=False)
        for mask in [0x40,0x10000,0x40000,0x80000,0x40000000,0x10000000]:
            with self.subTest(mask=mask),self.assertRaises(m.WindowsArchiveRefusal):m.validate_descriptor(self.info(allows=[('S-1-1-0',mask,0)]),self.api.current_sid,private=False)
    def test_reparse_network_filesystem_owner_null_acl_refused(self):
        for changed in [dict(reparse=True),dict(fixed=False),dict(filesystem='ReFS'),dict(owner='S-1-1-0'),dict(allows=None)]:
            with self.subTest(changed=changed),self.assertRaises(m.WindowsArchiveRefusal):m.validate_descriptor(self.info(**changed),self.api.current_sid,private=True)
    def test_unknown_allow_ace_is_not_silently_ignored(self):
        with self.assertRaises(m.WindowsArchiveRefusal):m.validate_descriptor(self.info(unknown_aces=True),self.api.current_sid,private=True)
    def test_inherit_only_rule_does_not_grant_current_object_access(self):
        m.validate_descriptor(self.info(allows=[('S-1-1-0',0x1f01ff,8)]),self.api.current_sid,private=True)
    def test_named_file_flush_is_required_and_handle_always_closed(self):
        self.guard.flush_file(r'C:\TEST_ONLY\archive\segment.gz')
        self.assertTrue(any(e[0]=='flush' for e in self.api.events))
        self.assertEqual(sum(e[0]=='open' for e in self.api.events),sum(e[0]=='close' for e in self.api.events))
    def test_flush_failure_propagates_and_releases_every_handle(self):
        self.api.fail_flush=True
        with self.assertRaises(OSError):self.guard.flush_file(r'C:\TEST_ONLY\archive\segment.gz')
        self.assertEqual(sum(e[0]=='open' for e in self.api.events),sum(e[0]=='close' for e in self.api.events))
    def test_identity_change_before_release_refused(self):
        original=self.api.flush
        def mutate(h):original(h);self.api.changed=True
        self.api.flush=mutate
        with self.assertRaises(m.WindowsArchiveRefusal):self.guard.flush_file(r'C:\TEST_ONLY\segment.gz')
    def test_write_through_publication_cannot_replace_or_copy(self):
        self.api.fail_move=True
        with self.assertRaises(OSError):self.guard.publish(r'C:\TEST_ONLY\tmp',r'C:\TEST_ONLY\segment.gz')
        move=next(e for e in self.api.events if e[0]=='move');self.assertEqual(move[-1],8)
        self.assertFalse(any(e[0]=='flush' for e in self.api.events))
    def test_successful_publication_flushes_named_target_and_preserves_identity(self):
        self.guard.publish(r'C:\TEST_ONLY\tmp',r'C:\TEST_ONLY\segment.gz')
        self.assertTrue(any(e[0]=='flush' and e[1].endswith('segment.gz') for e in self.api.events))
        self.assertEqual(sum(e[0]=='open' for e in self.api.events),sum(e[0]=='close' for e in self.api.events))
    def test_cross_directory_and_device_paths_refused_before_api(self):
        for a,b in [(r'C:\a\tmp',r'C:\b\dest'),(r'\\server\share\tmp',r'\\server\share\dest'),(r'\\?\C:\tmp',r'\\?\C:\dest'),(r'C:\TEST_ONLY\tmp:ads',r'C:\TEST_ONLY\dest')]:
            with self.subTest(a=a),self.assertRaises(m.WindowsArchiveRefusal):self.guard.publish(a,b)
        self.assertEqual(self.api.events,[])
    def test_os_owned_volume_root_is_admitted_as_ancestor(self):
        original=self.api.describe
        def root_descriptor(handle):
            info=original(handle)
            if handle == 'C:\\':info['owner']='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
            return info
        self.api.describe=root_descriptor
        self.guard.check(r'C:\TEST_ONLY\private-file')
        self.assertEqual(sum(e[0]=='open' for e in self.api.events),sum(e[0]=='close' for e in self.api.events))
    def test_trustedinstaller_is_not_admitted_as_private_leaf_or_nonroot_owner(self):
        original=self.api.describe
        def foreign_owner(handle):
            info=original(handle);info['owner']='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';return info
        self.api.describe=foreign_owner
        for target in ['C:\\',r'C:\TEST_ONLY\private-file']:
            with self.subTest(target=target),self.assertRaises(m.WindowsArchiveRefusal):self.guard.check(target)
    def test_owner_rights_is_bound_only_to_an_already_trusted_owner(self):
        m.validate_descriptor(self.info(allows=[('S-1-3-4',0x1f01ff,3)]),self.api.current_sid,private=True)
        for info in [self.info(owner='S-1-1-0',allows=[('S-1-3-4',0x1f01ff,3)]),self.info(allows=[('S-1-3-4',0x1f01ff,3),('S-1-1-0',1,0)])]:
            with self.subTest(info=info),self.assertRaises(m.WindowsArchiveRefusal):m.validate_descriptor(info,self.api.current_sid,private=True)
        with self.assertRaises(m.WindowsArchiveRefusal):m.validate_descriptor(self.info(owner='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',allows=[('S-1-3-4',0x1f01ff,3)]),self.api.current_sid,private=False,volume_root=True)
if __name__=='__main__':unittest.main(verbosity=2)
