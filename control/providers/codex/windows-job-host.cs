// Author: Bishop Crockett
// Owner: Argellan.com
// Optional owned-process host. No protocol data or command arguments are logged.
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
public static class CodexOwnedJobHost {
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {public long ProcessTime;public long JobTime;public uint Flags;public UIntPtr MinWS;public UIntPtr MaxWS;public uint ActiveLimit;public UIntPtr Affinity;public uint Priority;public uint Scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {public BASIC_LIMIT Basic;public IO_COUNTERS Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {public long UserTime,KernelTime,PeriodUserTime,PeriodKernelTime;public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO {public int cb;public string reserved,desktop,title;public uint x,y,xSize,ySize,xChars,yChars,fill,flags;public short show,extra;public IntPtr extraBytes,stdin,stdout,stderr;}
 [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct FILETIME {public uint low,high;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNTING data,uint length,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESSINFO info);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int type);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle,out FILETIME created,out FILETIME exited,out FILETIME kernel,out FILETIME user);
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 static string Quote(string value) {var b=new StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='"'){b.Append('\\',slashes*2+1);b.Append('"');}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);b.Append('"');return b.ToString();}
 static ACCOUNTING Accounting(IntPtr job) {ACCOUNTING a;uint n;if(!QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),out n))throw new Exception("JOB_QUERY");return a;}
 static void WriteState(string file,string nonce,string phase,PROCESSINFO process,bool assigned,bool exited,ACCOUNTING a,uint exitCode,ulong created,string failure) {
  string text="{\"version\":1,\"nonce\":\""+nonce+"\",\"phase\":\""+phase+"\",\"hostPid\":"+GetCurrentProcessId()+",\"nativePid\":"+process.pid+",\"nativeCreationFileTime\":\""+created+"\",\"assignedBeforeResume\":"+(assigned?"true":"false")+",\"rootExited\":"+(exited?"true":"false")+",\"activeProcesses\":"+a.ActiveProcesses+",\"totalProcesses\":"+a.TotalProcesses+",\"nativeExitCode\":"+exitCode+",\"breakawayAllowed\":false,\"jobMemoryLimitBytes\":536870912,\"maxProcesses\":16,\"failure\":\""+failure+"\"}";
  using(var f=new FileStream(file,FileMode.Create,FileAccess.Write,FileShare.Read)){byte[] data=new UTF8Encoding(false).GetBytes(text);f.Write(data,0,data.Length);f.Flush(true);}
 }
 public static int Main(string[] args) {
  if(args.Length<4)return 10;Guid nonceGuid;if(!Guid.TryParse(args[2],out nonceGuid))return 11;
  string status=args[0],stop=args[1],nonce=args[2];IntPtr job=IntPtr.Zero;PROCESSINFO process=new PROCESSINFO();bool assigned=false,rootExited=false;ulong created=0;uint exitCode=259;string failure="HOST_FAILURE";
  try {
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception("JOB_CREATE");
   EXTENDED_LIMIT limits=new EXTENDED_LIMIT();limits.Basic.Flags=0x2000|0x200|0x8;limits.Basic.ActiveLimit=16;limits.JobMemory=new UIntPtr(536870912);
   IntPtr buffer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMIT)));try{Marshal.StructureToPtr(limits,buffer,false);if(!SetInformationJobObject(job,9,buffer,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))throw new Exception("JOB_LIMIT");}finally{Marshal.FreeHGlobal(buffer);}
   STARTUPINFO si=new STARTUPINFO();si.cb=Marshal.SizeOf(typeof(STARTUPINFO));si.flags=0x100;si.stdin=GetStdHandle(-10);si.stdout=GetStdHandle(-11);si.stderr=GetStdHandle(-12);
   foreach(IntPtr h in new IntPtr[]{si.stdin,si.stdout,si.stderr})if(h!=IntPtr.Zero&&h!=new IntPtr(-1)&&!SetHandleInformation(h,1,1))throw new Exception("STD_HANDLE");
   var command=new StringBuilder();for(int i=3;i<args.Length;i++){if(i>3)command.Append(' ');command.Append(Quote(args[i]));}
   if(!CreateProcess(args[3],command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x08000000,IntPtr.Zero,null,ref si,out process))throw new Exception("PROCESS_CREATE");
   if(!AssignProcessToJobObject(job,process.process))throw new Exception("JOB_ASSIGN");assigned=true;
   FILETIME c,e,k,u;if(!GetProcessTimes(process.process,out c,out e,out k,out u))throw new Exception("PROCESS_IDENTITY");created=((ulong)c.high<<32)|c.low;
   if(ResumeThread(process.thread)==0xFFFFFFFF)throw new Exception("PROCESS_RESUME");CloseHandle(process.thread);process.thread=IntPtr.Zero;
   WriteState(status,nonce,"RUNNING",process,assigned,false,Accounting(job),exitCode,created,"");
   for(;;){uint wait=WaitForSingleObject(process.process,100);if(wait==0){rootExited=true;break;}if(wait!=258)throw new Exception("PROCESS_WAIT");
    if(File.Exists(stop)){if(File.ReadAllText(stop).Trim()!=nonce)throw new Exception("STOP_NONCE");if(!TerminateJobObject(job,0))throw new Exception("JOB_TERMINATE");}
   }
   ACCOUNTING accounting=Accounting(job);if(accounting.ActiveProcesses!=0&&!TerminateJobObject(job,0))throw new Exception("DESCENDANT_TERMINATE");
   var until=Stopwatch.StartNew();while((accounting=Accounting(job)).ActiveProcesses!=0){if(until.ElapsedMilliseconds>=5000)throw new Exception("TREE_EXIT_TIMEOUT");Thread.Sleep(20);}
   if(!GetExitCodeProcess(process.process,out exitCode))throw new Exception("EXIT_CODE");
   WriteState(status,nonce,"EXITED",process,assigned,rootExited,accounting,exitCode,created,"");
   return 0;
  } catch(Exception ex) {
   failure=ex.Message;switch(failure){case "JOB_CREATE":case "JOB_LIMIT":case "STD_HANDLE":case "PROCESS_CREATE":case "JOB_ASSIGN":case "PROCESS_IDENTITY":case "PROCESS_RESUME":case "PROCESS_WAIT":case "STOP_NONCE":case "JOB_TERMINATE":case "DESCENDANT_TERMINATE":case "TREE_EXIT_TIMEOUT":case "EXIT_CODE":case "JOB_QUERY":break;default:failure="HOST_FAILURE";break;}
   if(job!=IntPtr.Zero)TerminateJobObject(job,1);if(process.process!=IntPtr.Zero){TerminateProcess(process.process,1);WaitForSingleObject(process.process,5000);}
   try{WriteState(status,nonce,"FAILED",process,assigned,rootExited,new ACCOUNTING(),exitCode,created,failure);}catch{}
   return 12;
  } finally {if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);if(job!=IntPtr.Zero)CloseHandle(job);}
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
}