# Author: Bishop Crockett
# Owner: Argellan.com
# SPDX-License-Identifier: MIT
"""Receiver ACK regressions; all storage/Win32 effects are injected."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
receiver_file=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).parents[1]/'scripts'/'archive-receiver.py'
spec=importlib.util.spec_from_file_location('receiver_under_test',receiver_file)
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class DB:
    def __init__(self):self.in_transaction=False;self.closed=False;self.committed=False
    def execute(self,sql,*args):
        if sql=='BEGIN IMMEDIATE':self.in_transaction=True
        if sql=='COMMIT':self.in_transaction=False;self.committed=True
        if sql=='ROLLBACK':self.in_transaction=False
        return self
    def fetchone(self):return ('segments/TEST_ONLY.gz',)
    def close(self):self.closed=True
class Guard:
    def __init__(self,fail=None):self.calls=[];self.fail=fail
    def flush_file(self,file):
        self.calls.append(str(file))
        if len(self.calls)-1==self.fail:raise OSError('TEST_ONLY flush refusal')
class ReceiverAckTests(unittest.TestCase):
    def run_case(self,guard):
        db=DB();compressed=b'TEST_ONLY';raw=b'TEST_ONLY_RAW';records=[({'version':1},b'TEST_ONLY',0)]
        manifest=dict(rawSha256='a'*64,compressedSha256='b'*64,itemIds=['c'*64]);config=dict(timescale={},root=Path('TEST_ONLY_COLD'),catalogRoot=Path('TEST_ONLY_CATALOG'),receiverId='TEST_ONLY_RECEIVER')
        with patch.object(r,'decode_segment',return_value=(raw,records)),patch.object(r,'segment_metadata',return_value=('segments/TEST_ONLY.gz',manifest)),patch.object(r,'connect',return_value=db),patch.object(r,'checked_segment',return_value=(compressed,raw,records,manifest)),patch.object(r,'index_segment'),patch.object(r,'fsync_directory'),patch.object(r,'validate_storage'),patch.object(r,'windows_guard',return_value=guard,create=True):
            try:return r.receive(config,compressed),db
            finally:self.assertTrue(db.closed)
    def test_no_durable_receipt_if_any_named_flush_refuses_after_commit(self):
        for fail in range(3):
            with self.subTest(fail=fail),self.assertRaises(OSError):self.run_case(Guard(fail))
    def test_exact_retry_flushes_all_three_files_before_same_receipt(self):
        first=Guard();a,db=self.run_case(first);second=Guard();b,_=self.run_case(second)
        self.assertTrue(db.committed);self.assertTrue(a['durable']);self.assertEqual(a,b)
        self.assertEqual(len(first.calls),3);self.assertEqual(first.calls,second.calls)
        self.assertTrue(first.calls[-1].endswith('catalog.sqlite'))
    def test_missing_windows_ancestors_use_nearest_existing_directory_without_creating_data(self):
        import tempfile
        with tempfile.TemporaryDirectory(prefix='TEST_ONLY_archive_ancestor_') as directory:
            calls=[]
            class ExistingOnly:
                def check(inner,path,private=True):
                    self.assertTrue(Path(path).exists(),'guard must inspect an existing ancestor')
                    calls.append((Path(path),private))
            with patch.object(r,'windows_guard',return_value=ExistingOnly()):
                r.trusted_ancestors(Path(directory)/'missing'/'nested'/'leaf')
            self.assertEqual(calls,[(Path(directory),False)])
            self.assertFalse((Path(directory)/'missing').exists())
if __name__=='__main__':unittest.main(argv=[sys.argv[0]],verbosity=2)
