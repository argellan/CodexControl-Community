#!/usr/bin/env python3
# Author: Bishop Crockett
# Owner: Argellan.com
# SPDX-License-Identifier: MIT
"""NTFS archive admission and no-replace write-through publication.
Native APIs are lazy; offline tests inject an API and never load a Windows DLL.
No ACL modification, elevation, volume flush, network path or delete API.
"""
from contextlib import contextmanager
from pathlib import PureWindowsPath
import ctypes
from ctypes import wintypes as w
import os
import re

class WindowsArchiveRefusal(OSError):
    pass

def refuse():
    raise WindowsArchiveRefusal('WINDOWS_ARCHIVE_GUARD_REFUSED')

def validate_descriptor(info, current_sid, private=True, volume_root=False):
    trusted={current_sid,'S-1-5-18','S-1-5-32-544'}
    # The OS-managed volume root is an ancestor, never a private data leaf.
    root_owner = volume_root and not private and info.get('owner') == 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
    if info.get('filesystem')!='NTFS' or not info.get('fixed') or info.get('reparse') or not (info.get('owner') in trusted or root_owner) or info.get('allows') is None or info.get('unknown_aces'):
        refuse()
    for sid,mask,flags in info['allows']:
        if flags & 8:  # INHERIT_ONLY_ACE does not apply to this object.
            continue
        # OWNER RIGHTS denotes this object's already validated owner, not a new principal.
        owner_rights = sid == 'S-1-3-4' and info.get('owner') in trusted
        if sid not in trusted and not owner_rights and (private or mask & 0x500D0040):
            refuse()

def local_path(value):
    text=str(value)
    p=PureWindowsPath(text)
    if not p.is_absolute() or len(p.drive)!=2 or p.drive[1]!=':' or any(ord(c)<32 for c in text) or any(part in ('.','..') for part in p.parts) or len(text)>1024 or len(p.parts)>32:
        refuse()
    for part in p.parts[1:]:
        if re.search(r'[<>:"|?*]',part) or part.endswith(('.', ' ')) or re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',part,re.IGNORECASE):refuse()
    return p

class WindowsArchiveGuard:
    def __init__(self, api=None):
        self.api=api if api is not None else NativeApi()

    @contextmanager
    def hold(self,path,private=True,write=False,rename=False):
        p=local_path(path);handles=[];snapshots=[]
        try:
            walk=PureWindowsPath(p.anchor)
            names=[walk]
            for part in p.parts[1:]:
                walk=walk/part;names.append(walk)
            for i,name in enumerate(names):
                leaf=i==len(names)-1
                handle=self.api.open(str(name),write=write and leaf,rename=rename and leaf)
                handles.append(handle)
                info=self.api.describe(handle)
                validate_descriptor(info,self.api.current_sid,private=private if leaf else False,volume_root=i==0)
                snapshots.append(info['identity'])
            yield handles[-1]
            for i,handle in enumerate(handles):
                info=self.api.describe(handle)
                validate_descriptor(info,self.api.current_sid,private=private if i==len(handles)-1 else False,volume_root=i==0)
                if info['identity']!=snapshots[i]:refuse()
        finally:
            close_error = None
            for handle in reversed(handles):
                try:self.api.close(handle)
                except Exception as error:close_error = error
            if close_error is not None:raise close_error

    def check(self,path,private=True):
        with self.hold(path,private):pass

    def flush_file(self,path):
        with self.hold(path,write=True) as handle:self.api.flush(handle)

    def publish(self,source,target,directory=False):
        a,b=local_path(source),local_path(target)
        if str(a.parent).casefold()!=str(b.parent).casefold() or a==b:refuse()
        with self.hold(a.parent),self.hold(a,rename=True) as original:
            identity=self.api.describe(original)['identity']
            # No REPLACE_EXISTING, COPY_ALLOWED or delayed/reboot operation.
            self.api.move(str(a),str(b),8)  # MOVEFILE_WRITE_THROUGH
            with self.hold(b,write=not directory) as published:
                if self.api.describe(published)['identity']!=identity:refuse()
                if not directory:self.api.flush(published)

class FILETIME(ctypes.Structure):
    _fields_=[('low',w.DWORD),('high',w.DWORD)]
class FILEINFO(ctypes.Structure):
    _fields_=[('attributes',w.DWORD),('created',FILETIME),('accessed',FILETIME),('written',FILETIME),('volume',w.DWORD),('size_high',w.DWORD),('size_low',w.DWORD),('links',w.DWORD),('index_high',w.DWORD),('index_low',w.DWORD)]
class ACL(ctypes.Structure):
    _fields_=[('revision',w.BYTE),('pad',w.BYTE),('size',w.WORD),('count',w.WORD),('pad2',w.WORD)]

class NativeApi:
    def __init__(self):
        if os.name!='nt':refuse()
        self.k=ctypes.WinDLL('kernel32',use_last_error=True)
        self.a=ctypes.WinDLL('advapi32',use_last_error=True)
        def bind(lib,name,result,args):
            f=getattr(lib,name);f.restype=result;f.argtypes=args;return f
        ptr=ctypes.c_void_p;dword=w.DWORD;handle=w.HANDLE
        self.create=bind(self.k,'CreateFileW',handle,[w.LPCWSTR,dword,dword,ptr,dword,dword,handle])
        self.close_handle=bind(self.k,'CloseHandle',w.BOOL,[handle])
        self.file_info=bind(self.k,'GetFileInformationByHandle',w.BOOL,[handle,ctypes.POINTER(FILEINFO)])
        self.volume_info=bind(self.k,'GetVolumeInformationByHandleW',w.BOOL,[handle,w.LPWSTR,dword,ctypes.POINTER(dword),ctypes.POINTER(dword),ctypes.POINTER(dword),w.LPWSTR,dword])
        self.drive_type=bind(self.k,'GetDriveTypeW',w.UINT,[w.LPCWSTR])
        self.flush_handle=bind(self.k,'FlushFileBuffers',w.BOOL,[handle])
        self.move_file=bind(self.k,'MoveFileExW',w.BOOL,[w.LPCWSTR,w.LPCWSTR,dword])
        self.security=bind(self.a,'GetSecurityInfo',dword,[handle,w.INT,dword,ctypes.POINTER(ptr),ptr,ctypes.POINTER(ptr),ptr,ctypes.POINTER(ptr)])
        self.get_ace=bind(self.a,'GetAce',w.BOOL,[ptr,dword,ctypes.POINTER(ptr)])
        self.sid_string=bind(self.a,'ConvertSidToStringSidW',w.BOOL,[ptr,ctypes.POINTER(ptr)])
        self.local_free=bind(self.k,'LocalFree',ptr,[ptr])
        self.process=bind(self.k,'GetCurrentProcess',handle,[])
        self.open_token=bind(self.a,'OpenProcessToken',w.BOOL,[handle,dword,ctypes.POINTER(handle)])
        self.token_info=bind(self.a,'GetTokenInformation',w.BOOL,[handle,w.INT,ptr,dword,ctypes.POINTER(dword)])
        token=handle()
        if not self.open_token(self.process(),8,ctypes.byref(token)):refuse()
        try:
            length=dword();self.token_info(token,1,None,0,ctypes.byref(length))
            if not 1<=length.value<=65536:refuse()
            data=ctypes.create_string_buffer(length.value)
            if not self.token_info(token,1,data,length,ctypes.byref(length)):refuse()
            self.current_sid=self._sid(ctypes.cast(data,ctypes.POINTER(ptr))[0])
        finally:self.close_handle(token)
        self.paths={}

    def _sid(self,sid):
        out=ctypes.c_void_p()
        if not sid or not self.sid_string(sid,ctypes.byref(out)):refuse()
        try:return ctypes.wstring_at(out)
        finally:self.local_free(out)

    def open(self,path,write=False,rename=False):
        access=0x20080|(0x40000000 if write else 0)
        handle=self.create(path,access,3|(4 if rename else 0),None,3,0x02200000|(0x80000000 if write else 0),None)
        if handle in (None,ctypes.c_void_p(-1).value):refuse()
        self.paths[handle]=path
        return handle

    def describe(self,handle):
        info=FILEINFO();filesystem=ctypes.create_unicode_buffer(32)
        if not self.file_info(handle,ctypes.byref(info)) or not self.volume_info(handle,None,0,None,None,None,filesystem,32):refuse()
        owner=ctypes.c_void_p();dacl=ctypes.c_void_p();descriptor=ctypes.c_void_p()
        if self.security(handle,1,5,ctypes.byref(owner),None,ctypes.byref(dacl),None,ctypes.byref(descriptor))!=0:refuse()
        try:
            allows=None;unknown=False
            if dacl:
                acl=ctypes.cast(dacl,ctypes.POINTER(ACL)).contents
                if acl.count>1024:refuse()
                allows=[]
                for i in range(acl.count):
                    ace=ctypes.c_void_p()
                    if not self.get_ace(dacl,i,ctypes.byref(ace)):refuse()
                    header=ctypes.string_at(ace,4);kind,flags=header[0],header[1]
                    size=int.from_bytes(header[2:4],'little')
                    if kind not in (0,1) or size<12:unknown=True;continue
                    if kind==0:
                        mask=ctypes.c_uint32.from_address(ace.value+4).value
                        allows.append((self._sid(ace.value+8),mask,flags))
            return dict(owner=self._sid(owner),allows=allows,unknown_aces=unknown,filesystem=filesystem.value,fixed=self.drive_type(str(local_path(self.paths[handle]).anchor))==3,reparse=bool(info.attributes&0x400),identity=(info.volume,info.index_high,info.index_low,info.created.high,info.created.low))
        finally:self.local_free(descriptor)

    def close(self,handle):
        self.paths.pop(handle,None)
        if not self.close_handle(handle):refuse()

    def flush(self,handle):
        if not self.flush_handle(handle):refuse()

    def move(self,source,target,flags):
        if flags!=8 or not self.move_file(source,target,flags):refuse()
