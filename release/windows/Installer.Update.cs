// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static partial class Installer {
 sealed class UpgradeResult { public bool WasRunning; public bool Started; public bool AlreadyCurrent; public string Backup; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry {
  public uint Size,Usage,Id; public IntPtr Heap; public uint Module,Threads,Parent; public int Priority; public uint Flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref ProcessEntry entry);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref ProcessEntry entry);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList([Out] uint[] pids,uint count);
 [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool ignore);
 [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint type,uint group);

 static Dictionary<string,object> UpgradeJson(string file,int bound=8388608) {
  RealLocal(file);var info=new FileInfo(file);if(!info.Exists||info.Length<1||info.Length>bound)throw new Exception("Update metadata is missing or exceeds its bound");
  return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
 }
 static string UpgradeHash(string file) { using(var stream=File.OpenRead(file))return Hash(stream); }
 static bool UpgradeSame(string a,string b) { return String.Equals(Path.GetFullPath(a).TrimEnd('\\'),Path.GetFullPath(b).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase); }
 static bool UpgradeInside(string file,string root) { return Path.GetFullPath(file).StartsWith(Path.GetFullPath(root).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase); }
 static void UpgradeMove(string source,string destination) {
  // A cleanly exited executable can retain a Windows image/console lock briefly.
  // Retry only an unchanged rename, never a transaction or private-data write.
  var wait=Stopwatch.StartNew();while(true)try{Directory.Move(source,destination);return;}catch(Exception error){int code=error.HResult&65535;if(!(error is IOException||error is UnauthorizedAccessException)||(code!=5&&code!=32&&code!=33)||wait.ElapsedMilliseconds>=5000||!Directory.Exists(source)||Directory.Exists(destination)||File.Exists(destination))throw;Thread.Sleep(100);}
 }
 static string UpgradeLocator(string destination) { return Path.Combine(Path.GetDirectoryName(destination),".codexcontrol-update.json"); }
 static void UpgradeWrite(string file,object value) {
  var temporary=file+".new-"+Guid.NewGuid().ToString("N");
  using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
   var bytes=Encoding.UTF8.GetBytes(Json.Serialize(value));stream.Write(bytes,0,bytes.Length);stream.Flush(true);
  }
  if(File.Exists(file))File.Replace(temporary,file,null);else File.Move(temporary,file);
 }
 static Dictionary<string,string> UpgradeInventory(string root) {
  RealLocal(root);var result=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);var pending=new Stack<string>();pending.Push(root);
  while(pending.Count>0)foreach(var entry in Directory.GetFileSystemEntries(pending.Pop())) {
   RealLocal(entry);var attributes=File.GetAttributes(entry);
   if((attributes&FileAttributes.Directory)!=0)pending.Push(entry);
   else result.Add(entry.Substring(root.Length+1).Replace('\\','/'),UpgradeHash(entry));
  }
  return result;
 }
 static void UpgradeAssertInventory(string root,Dictionary<string,string> expected) {
  var actual=UpgradeInventory(root);if(actual.Count!=expected.Count||expected.Any(pair=>!actual.ContainsKey(pair.Key)||actual[pair.Key]!=pair.Value))throw new Exception("Existing private files changed during the offline update; nothing was discarded");
 }
 static void UpgradeCopy(string source,string destination,Action<string> progress,Func<bool> cancelled) {
  RealLocal(source);PrivateDirectory(destination);var pending=new Stack<string>();pending.Push(source);int files=0;
  while(pending.Count>0)foreach(var entry in Directory.GetFileSystemEntries(pending.Pop())) {
   if(cancelled())throw new OperationCanceledException();RealLocal(entry);var relative=entry.Substring(source.Length+1);var target=Path.Combine(destination,relative);
   if((File.GetAttributes(entry)&FileAttributes.Directory)!=0){Directory.CreateDirectory(target);pending.Push(entry);continue;}
   Directory.CreateDirectory(Path.GetDirectoryName(target));
   using(var input=new FileStream(entry,FileMode.Open,FileAccess.Read,FileShare.Read))using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None)){input.CopyTo(output,1048576);output.Flush(true);}
   if(UpgradeHash(entry)!=UpgradeHash(target))throw new Exception("Update backup verification failed");File.SetLastWriteTimeUtc(target,File.GetLastWriteTimeUtc(entry));
   if(++files%250==0)progress("Backing up and verifying your private data ("+files+" files)");
  }
 }
 static Dictionary<string,string> UpgradeVerifyApplication(string root) {
  var manifest=UpgradeJson(Path.Combine(root,"INSTALLER_MANIFEST.json"));
  if((string)manifest["edition"]!="Community"||(string)manifest["platform"]!="win32-x64")throw new Exception("Existing application identity differs");
  var result=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
  foreach(Dictionary<string,object> row in (System.Collections.IEnumerable)manifest["files"]) {
   var relative=Member((string)row["path"]);var file=Path.Combine(root,relative.Replace('/','\\'));RealLocal(file);
   if(!result.TryAddCompat(relative,(string)row["sha256"])||new FileInfo(file).Length!=Convert.ToInt64(row["bytes"])||UpgradeHash(file)!=(string)row["sha256"])throw new Exception("Existing application files were modified or are incomplete; update stopped before replacement");
  }
  return result;
 }
 static Dictionary<string,object> UpgradeValidateInstallation(string destination,string instance,bool recovering=false,string original=null) {
  RealLocal(destination);RealLocal(instance);SafeAncestors(destination);SafeAncestors(instance);
  if(UpgradeSame(destination,instance)||UpgradeInside(destination,instance)||UpgradeInside(instance,destination))throw new Exception("Application and private instance must remain separate");
  var installed=UpgradeJson(Path.Combine(destination,"CE_INSTALLATION.json"),65536);
  string identityRoot=recovering?original:destination;
  if(!UpgradeSame((string)installed["application"],identityRoot)||!UpgradeSame((string)installed["instance"],instance))throw new Exception("Existing installation paths do not match this update");
  var pointer=UpgradeJson(Path.Combine(instance,"installation.json"),65536);
  if(Convert.ToInt32(pointer["schemaVersion"])!=1||!UpgradeSame((string)pointer["appDirectory"],Path.Combine(identityRoot,"app")))throw new Exception("Existing application pointer differs; no private configuration was changed");
  var hub=UpgradeJson(Path.Combine(instance,"hub.json"));RealLocal((string)hub["dataDirectory"]);
  if(!UpgradeInside((string)hub["dataDirectory"],instance))throw new Exception("This updater requires the active data directory inside the private instance; external archives remain untouched");
  foreach(var lease in new[]{Path.Combine(instance,"application-change.lock"),Path.Combine((string)hub["dataDirectory"],"restore.lock")})if(File.Exists(lease))throw new Exception("Another maintenance operation holds this instance; try again after it finishes");
  return installed;
 }
 static Dictionary<int,int> UpgradeParents() {
  var parents=new Dictionary<int,int>();var snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))throw new Exception("Cannot verify application process ownership");
  try{var entry=new ProcessEntry();entry.Size=(uint)Marshal.SizeOf(typeof(ProcessEntry));if(!Process32FirstW(snapshot,ref entry))throw new Exception("Cannot enumerate application ownership");do{parents[(int)entry.Id]=(int)entry.Parent;}while(Process32NextW(snapshot,ref entry));}finally{CloseHandle(snapshot);}return parents;
 }
 static bool UpgradeOwned(int pid,int launcher,Dictionary<int,int> parents) {
  if(pid==Process.GetCurrentProcess().Id)return true;var seen=new HashSet<int>();while(parents.ContainsKey(pid)&&seen.Add(pid)){if(pid==launcher)return true;pid=parents[pid];}return false;
 }
 static string UpgradePidFile(string instance){var hub=UpgradeJson(Path.Combine(instance,"hub.json"));object upstream;bool gateway=hub.TryGetValue("upstream",out upstream)&&upstream!=null;return Path.Combine((string)hub["dataDirectory"],gateway?"gateway-runtime.pid":"runtime.pid");}
 static bool UpgradeReady(string instance,int launcher){
  try{var hub=UpgradeJson(Path.Combine(instance,"hub.json"));var ready=UpgradeJson(Path.Combine((string)hub["dataDirectory"],"launcher-ready.json"),8192);var pid=UpgradeJson(UpgradePidFile(instance),8192);return Equals(ready["instanceId"],hub["instanceId"])&&Convert.ToInt32(ready["launcherPid"])==launcher&&Convert.ToInt32(ready["runtimePid"])==Convert.ToInt32(pid["pid"])&&!pid.ContainsKey("stoppedAt")&&DateTime.Parse((string)ready["readyAt"]).ToUniversalTime()>=DateTime.Parse((string)pid["startedAt"]).ToUniversalTime();}catch{return false;}
 }
 static void UpgradeStopFamily(int launcher,string destination,int runtime,string instance) {
  using(var owner=Process.GetProcessById(launcher)) {
   if(!UpgradeSame(owner.MainModule.FileName,Path.Combine(destination,"CodexControl-Community.exe")))throw new Exception("Running launcher identity differs; no process was stopped");
   var parents=UpgradeParents();
   if(runtime==0)foreach(var pair in parents.Where(p=>p.Value==launcher))try{using(var candidate=Process.GetProcessById(pair.Key))if(UpgradeSame(candidate.MainModule.FileName,Path.Combine(destination,@"runtimes\node\node.exe"))){if(runtime!=0)throw new Exception("More than one owned runtime found");runtime=pair.Key;}}catch(ArgumentException){}
   if(runtime>0&&(!parents.ContainsKey(runtime)||parents[runtime]!=launcher))throw new Exception("Runtime parent differs; no process was stopped");
   if(runtime>0)using(var process=Process.GetProcessById(runtime))if(!UpgradeSame(process.MainModule.FileName,Path.Combine(destination,@"runtimes\node\node.exe")))throw new Exception("Runtime executable differs; no process was stopped");
   Process runtimeProcess=runtime>0?Process.GetProcessById(runtime):null;
   FreeConsole();if(!AttachConsole((uint)(runtime>0?runtime:launcher))){if(runtimeProcess!=null)runtimeProcess.Dispose();throw new Exception("Cannot request a safe application stop; close CodexControl and try again");}
   try {
    var members=new uint[256];uint count=GetConsoleProcessList(members,256);if(count==0||count>256||members.Take((int)count).Any(pid=>!UpgradeOwned((int)pid,launcher,parents)))throw new Exception("Console contains unrelated processes; close CodexControl and try again");
    if(!SetConsoleCtrlHandler(IntPtr.Zero,true)||!GenerateConsoleCtrlEvent(0,0))throw new Exception("Safe stop request failed; no process was force-terminated");
   // This routine runs only in a short-lived helper. Keep CTRL_C ignored until
   // that helper exits: resetting it immediately can race the queued signal.
   }finally{FreeConsole();}
   var watch=Stopwatch.StartNew();if(runtimeProcess!=null)using(runtimeProcess){if(!runtimeProcess.WaitForExit(75000))throw new Exception("CodexControl is still closing its data; update stopped without forcing it");}
   if(!owner.WaitForExit(Math.Max(1,80000-(int)watch.ElapsedMilliseconds)))throw new Exception("The owned launcher is still closing; update stopped");
   if(runtime>0){var record=UpgradeJson(UpgradePidFile(instance),8192);object closed;if(Convert.ToInt32(record["pid"])!=runtime||!record.TryGetValue("stoppedAt",out closed)||!(closed is string))throw new Exception("Clean data-close receipt missing; update stopped");}
  }
 }
 static bool UpgradeStop(string destination,string instance,Action<string> progress) {
  var hub=UpgradeJson(Path.Combine(instance,"hub.json"));var file=UpgradePidFile(instance);
  if(!File.Exists(file)){if(SameDashboard(DashboardOrigin(instance),(string)hub["instanceId"]))throw new Exception("A live instance lacks its process identity; update stopped");return false;}
  var record=UpgradeJson(file,8192);if(!Equals(record["instanceId"],hub["instanceId"]))throw new Exception("Runtime instance identity differs");int pid=Convert.ToInt32(record["pid"]);Process process;
  try{process=Process.GetProcessById(pid);}catch(ArgumentException){object stopped;if(!record.TryGetValue("stoppedAt",out stopped))throw new Exception("Previous runtime did not record a clean close; open and close it before updating");return false;}
  using(process){object stopped;if(record.TryGetValue("stoppedAt",out stopped))throw new Exception("Stale process identifier is in use; update stopped without signaling it");DateTime started=DateTime.Parse((string)record["startedAt"],null,System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();var age=started-process.StartTime.ToUniversalTime();if(age.TotalSeconds<0||age.TotalSeconds>120)throw new Exception("Runtime creation time differs; no process was stopped");}
  var parents=UpgradeParents();if(!parents.ContainsKey(pid))throw new Exception("Runtime ownership changed");
  var metadata=UpgradeJson(Path.Combine(destination,"CE_INSTALLATION.json"),65536);object readyVersion;
  if(metadata.TryGetValue("upgradeReadiness",out readyVersion)&&Convert.ToInt32(readyVersion)==1){var wait=Stopwatch.StartNew();while(wait.ElapsedMilliseconds<45000&&!UpgradeReady(instance,parents[pid]))Thread.Sleep(100);if(!UpgradeReady(instance,parents[pid]))throw new Exception("The application is still starting and has not acknowledged safe shutdown; wait before updating");}
  progress("Closing CodexControl safely and preserving pending records");UpgradeStopFamily(parents[pid],destination,pid,instance);return true;
 }
 static bool UpgradeRequestStop(string destination,string instance,Action<string> progress,int launcher=0) {
  progress("Closing CodexControl safely and preserving pending records");
  var command=(launcher>0?"--stop-launcher="+launcher:"--stop")+" --destination="+Quote(destination)+" --instance="+Quote(instance);
  var start=new ProcessStartInfo(OwnExe,command){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
  using(var child=Process.Start(start)){var output=new StringBuilder();var errors=new StringBuilder();child.OutputDataReceived+=(s,e)=>{if(e.Data!=null&&output.Length<65536)output.AppendLine(e.Data);};child.ErrorDataReceived+=(s,e)=>{if(e.Data!=null&&errors.Length<65536)errors.AppendLine(e.Data);};child.BeginOutputReadLine();child.BeginErrorReadLine();
   if(!child.WaitForExit(100000)){child.Kill();throw new Exception("The stateless close helper timed out; no application replacement was attempted");}child.WaitForExit();if(child.ExitCode!=0)throw new Exception("CodexControl could not close safely. Close its window and try the update again. "+errors.ToString().Trim());if(output.ToString().Contains("OWNED_RUNTIME_CLOSED"))return true;if(output.ToString().Contains("INSTANCE_ALREADY_OFFLINE"))return false;throw new Exception("The close helper did not return a verified completion receipt");}
 }
 static void UpgradeCompatibility(string staged,string current,string instance) {
  var old=UpgradeJson(Path.Combine(current,@"app\RELEASE_MANIFEST.json"));var next=UpgradeJson(Path.Combine(staged,@"app\RELEASE_MANIFEST.json"));
  if(!old.ContainsKey("administrationFormat")||!next.ContainsKey("administrationFormat")||Json.Serialize(old["administrationFormat"])!=Json.Serialize(next["administrationFormat"]))throw new Exception("This application has a different authority format; update requires a compatible reader");
  var hub=UpgradeJson(Path.Combine(instance,"hub.json"));var authority=Path.Combine((string)hub["dataDirectory"],"administration");var file=Path.Combine(authority,"administration.json");var checksum=UpgradeHash(file);
  var start=new ProcessStartInfo(Path.Combine(staged,@"runtimes\node\node.exe"),Quote(Path.Combine(staged,@"app\scripts\verify-administration.mjs"))+" --directory="+Quote(authority)+" --sha256="+checksum+" --instance="+Quote((string)hub["instanceId"])){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=staged};
  foreach(var name in new[]{"NODE_OPTIONS","NODE_PATH","PYTHONPATH","PYTHONHOME"})start.EnvironmentVariables.Remove(name);
  using(var child=Process.Start(start)){var output=new StringBuilder();child.OutputDataReceived+=(s,e)=>{if(e.Data!=null&&output.Length<65536)output.AppendLine(e.Data);};child.ErrorDataReceived+=(s,e)=>{};child.BeginOutputReadLine();child.BeginErrorReadLine();if(!child.WaitForExit(15000)){child.Kill();throw new Exception("Read-only compatibility probe timed out");}child.WaitForExit();if(child.ExitCode!=0)throw new Exception("New application cannot read the existing accounts safely");var result=Json.Deserialize<Dictionary<string,object>>(output.ToString());if(!Equals(result["status"],"COMPATIBLE_CURRENT_AUTHORITY")||!Equals(result["instanceId"],hub["instanceId"])||!Equals(result["sha256"],checksum)||UpgradeHash(file)!=checksum)throw new Exception("Existing account compatibility verification failed");}
 }
 static void UpgradeCarryExtras(string current,string staged,Dictionary<string,string> covered,Dictionary<string,string> all) {
  foreach(var directory in Directory.GetDirectories(current,"*",SearchOption.AllDirectories)){var target=Path.Combine(staged,directory.Substring(current.Length+1));if(File.Exists(target))throw new Exception("An existing application directory conflicts with this update");Directory.CreateDirectory(target);}
  foreach(var pair in all){if(covered.ContainsKey(pair.Key)||pair.Key.Equals("INSTALLER_MANIFEST.json",StringComparison.OrdinalIgnoreCase)||pair.Key.Equals("CE_INSTALLATION.json",StringComparison.OrdinalIgnoreCase)||pair.Key.Equals("CodexControl-Community.exe",StringComparison.OrdinalIgnoreCase))continue;var target=Path.Combine(staged,pair.Key.Replace('/','\\'));if(File.Exists(target)||Directory.Exists(target))throw new Exception("An existing custom application file conflicts with this update; original retained");Directory.CreateDirectory(Path.GetDirectoryName(target));File.Copy(Path.Combine(current,pair.Key.Replace('/','\\')),target,false);if(UpgradeHash(target)!=pair.Value)throw new Exception("Custom application file copy failed");}
 }
 static void UpgradePhase(Dictionary<string,object> journal,string phase,string locator) {journal["phase"]=phase;journal["updatedAt"]=DateTime.UtcNow.ToString("o");UpgradeWrite(Path.Combine((string)journal["transaction"],"UPDATE_RECEIPT.json"),journal);UpgradeWrite(locator,journal);}
 static void UpgradeFault(Dictionary<string,string> args,string phase,string transaction,bool testOnly) {
  if(!args.ContainsKey("test-only")||!testOnly)return;
  if(Environment.GetEnvironmentVariable("CODEXCONTROL_TEST_UPDATE_FAIL_AT")==phase)throw new Exception("TEST_ONLY injected update failure");
  if(Environment.GetEnvironmentVariable("CODEXCONTROL_TEST_UPDATE_PAUSE_AT")==phase){File.WriteAllText(Path.Combine(transaction,"TEST_ONLY_PAUSED"),phase);Thread.Sleep(30000);throw new Exception("TEST_ONLY interrupted-update pause expired");}
 }
 static void UpgradeRollback(Dictionary<string,object> journal,string locator) {
  string destination=(string)journal["destination"],transaction=(string)journal["transaction"],previous=Path.Combine(transaction,"application-before");
  if(Directory.Exists(previous)){if(Directory.Exists(destination))UpgradeMove(destination,Path.Combine(transaction,"failed-"+Guid.NewGuid().ToString("N").Substring(0,12)));UpgradeMove(previous,destination);UpgradeVerifyApplication(destination);}
  UpgradePhase(journal,"rolled-back-private-data-retained",locator);File.Delete(locator);
 }
 static void UpgradeRecover(string destination,string instance,Action<string> progress) {
  var locator=UpgradeLocator(destination);if(!File.Exists(locator))return;var journal=UpgradeJson(locator,65536);var transaction=RealLocal((string)journal["transaction"]);var backups=Path.Combine(Path.GetDirectoryName(destination),"maintenance-backups");
  if(!UpgradeSame((string)journal["destination"],destination)||!UpgradeSame((string)journal["instance"],instance)||!UpgradeInside(transaction,backups)||!Path.GetFileName(transaction).StartsWith("installer-update-",StringComparison.Ordinal))throw new Exception("Interrupted update identity differs; files left untouched");
  if(Equals(journal["phase"],"committed")){UpgradeVerifyApplication(destination);if(UpgradeHash(Path.Combine(destination,"INSTALLER_MANIFEST.json"))!=(string)journal["targetManifestSha256"])throw new Exception("Completed update identity changed; files left untouched");File.Delete(locator);return;}
  var previous=Path.Combine(transaction,"application-before");if(Directory.Exists(previous)){UpgradeValidateInstallation(previous,instance,true,destination);UpgradeVerifyApplication(previous);if(UpgradeHash(Path.Combine(previous,"INSTALLER_MANIFEST.json"))!=(string)journal["sourceManifestSha256"])throw new Exception("Previous application identity changed; recovery stopped");}
  progress("Recovering the previous application; private data stays in place");
  if(Directory.Exists(destination)){UpgradeValidateInstallation(destination,instance);var identity=UpgradeHash(Path.Combine(destination,"INSTALLER_MANIFEST.json"));if(identity!=(string)journal["sourceManifestSha256"]&&identity!=(string)journal["targetManifestSha256"])throw new Exception("Recovery destination changed; files left untouched");UpgradeRequestStop(destination,instance,progress);}
  UpgradeRollback(journal,locator);
 }
 static Process UpgradeStart(string destination,string nonce=null) {
  // Shell launch owns a separate console instead of inheriting the installer's
  // output pipes or detached process group. Launch sanitizes the runtime environment.
  var start=new ProcessStartInfo(Path.Combine(destination,"CodexControl-Community.exe"),"--launch --no-browser"+(nonce==null?"":" --upgrade-start="+Quote(nonce))){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=destination};return Process.Start(start);
 }
 static void UpgradeWaitReady(string instance,Process started) {
  var watch=Stopwatch.StartNew();var origin=DashboardOrigin(instance);var identity=DashboardInstance(instance);while(watch.ElapsedMilliseconds<45000&&(!UpgradeReady(instance,started.Id)||!SameDashboard(origin,identity))){if(started.HasExited)throw new Exception("Application did not start");Thread.Sleep(250);}if(!UpgradeReady(instance,started.Id)||!SameDashboard(origin,identity))throw new Exception("Application did not acknowledge operational readiness");
 }
 static UpgradeResult Update(Dictionary<string,string> args,Action<string> progress,Func<bool> cancelled) {
  string destination=RealLocal(args["destination"]),instance=RealLocal(args["instance"]);if(UpgradeInside(OwnExe,destination))throw new Exception("Run the downloaded installer outside the application folder to update");
  if(args.ContainsKey("role")||args.ContainsKey("port")||args.ContainsKey("session-root"))throw new Exception("Existing settings are retained during update; change them in Settings");
  ExistingParent(destination);ExistingParent(instance);var lockName="Local\\ARGELLAN.CodexControl.Update."+UpgradeHashText(destination.ToLowerInvariant()+WindowsIdentity.GetCurrent().User.Value);
  using(var mutex=new Mutex(false,lockName)){bool held=false;try{try{held=mutex.WaitOne(0);}catch(AbandonedMutexException){held=true;}if(!held)throw new Exception("Another installer is already updating this application");
   UpgradeRecover(destination,instance,progress);if(args.ContainsKey("recover-update"))return new UpgradeResult();
   var installed=UpgradeValidateInstallation(destination,instance);bool testOnly=installed.ContainsKey("testOnly")&&Equals(installed["testOnly"],true);if(args.ContainsKey("test-only")&&(!testOnly||destination.IndexOf("TEST_ONLY",StringComparison.OrdinalIgnoreCase)<0||instance.IndexOf("TEST_ONLY",StringComparison.OrdinalIgnoreCase)<0))throw new Exception("TEST_ONLY update requires a marked test installation");
   progress("Verifying the new installer and existing application");Payload(null);var covered=UpgradeVerifyApplication(destination);var all=UpgradeInventory(destination);
   var oldManifest=UpgradeHash(Path.Combine(destination,"INSTALLER_MANIFEST.json"));
   using(var embedded=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))using(var archive=new ZipArchive(embedded,ZipArchiveMode.Read))using(var metadata=archive.GetEntry("INSTALLER_MANIFEST.json").Open()) {
    if(!args.ContainsKey("test-only")&&Hash(metadata)==oldManifest&&UpgradeHash(Path.Combine(destination,"CodexControl-Community.exe"))==UpgradeHash(OwnExe)){if(args.ContainsKey("launch"))using(var existing=UpgradeStart(destination)){}return new UpgradeResult{AlreadyCurrent=true};}
   }
   var backups=Path.Combine(Path.GetDirectoryName(destination),"maintenance-backups");if(!Directory.Exists(backups))PrivateDirectory(backups);else SafeAncestors(backups);
   var transaction=Path.Combine(backups,"installer-update-"+Guid.NewGuid().ToString("N").Substring(0,16));if(Directory.Exists(transaction)||File.Exists(transaction))throw new Exception("Update staging collision; no existing files changed");PrivateDirectory(transaction);var staged=Path.Combine(transaction,"new");PrivateDirectory(staged);Payload(staged);File.Copy(OwnExe,Path.Combine(staged,"CodexControl-Community.exe"),false);var stagedMetadata=new Dictionary<string,object>(installed);stagedMetadata["upgradeReadiness"]=1;UpgradeWrite(Path.Combine(staged,"CE_INSTALLATION.json"),stagedMetadata);UpgradeCarryExtras(destination,staged,covered,all);UpgradeVerifyApplication(staged);
   var journal=new Dictionary<string,object>{{"version",1},{"destination",destination},{"instance",instance},{"transaction",transaction},{"sourceManifestSha256",oldManifest},{"targetManifestSha256",UpgradeHash(Path.Combine(staged,"INSTALLER_MANIFEST.json"))},{"phase","staged"},{"privateDataPolicy","Retained in place; never restore an old snapshot over later records"}};var locator=UpgradeLocator(destination);bool running=false,promoted=false;Process started=null;
   try {
    if(cancelled())throw new OperationCanceledException();running=UpgradeRequestStop(destination,instance,progress);journal["wasRunning"]=running;UpgradePhase(journal,"offline",locator);
    progress("Backing up and verifying your history, settings and credentials");var privateBefore=UpgradeInventory(instance);long need=new DirectoryInfo(instance).EnumerateFiles("*",SearchOption.AllDirectories).Sum(f=>f.Length)+67108864;if(new DriveInfo(Path.GetPathRoot(transaction)).AvailableFreeSpace<need)throw new Exception("Not enough local disk space for a verified private backup");UpgradeCopy(instance,Path.Combine(transaction,"instance-snapshot"),progress,cancelled);UpgradeAssertInventory(instance,privateBefore);UpgradeWrite(Path.Combine(transaction,"PRIVATE_BACKUP_MANIFEST.json"),privateBefore);
    UpgradeCompatibility(staged,destination,instance);UpgradeAssertInventory(instance,privateBefore);if(UpgradeHash(Path.Combine(destination,"INSTALLER_MANIFEST.json"))!=oldManifest)throw new Exception("Application changed during update preparation");UpgradeVerifyApplication(destination);
    UpgradePhase(journal,"prepared",locator);UpgradeFault(args,"prepared",transaction,testOnly);if(cancelled())throw new OperationCanceledException();
    progress("Installing the verified application update");UpgradeMove(destination,Path.Combine(transaction,"application-before"));UpgradePhase(journal,"old-moved",locator);UpgradeFault(args,"old-moved",transaction,testOnly);
    UpgradeMove(staged,destination);promoted=true;UpgradePhase(journal,"promoted",locator);UpgradeFault(args,"promoted",transaction,testOnly);UpgradeVerifyApplication(destination);UpgradeAssertInventory(instance,privateBefore);
    if(running||args.ContainsKey("launch")) {
     progress("Checking the updated application");journal["startupNonce"]=Guid.NewGuid().ToString("N");UpgradePhase(journal,"starting",locator);started=UpgradeStart(destination,(string)journal["startupNonce"]);journal["startedLauncherPid"]=started.Id;UpgradePhase(journal,"starting",locator);UpgradeWaitReady(instance,started);
    }
    UpgradeFault(args,"before-commit",transaction,testOnly);UpgradePhase(journal,"committed",locator);File.Delete(locator);progress("Update complete. Your captured history, settings and accounts are retained.");return new UpgradeResult{WasRunning=running,Started=started!=null,Backup=transaction};
   }catch(Exception failure){
    if(started!=null&&!started.HasExited){try{UpgradeRequestStop(destination,instance,progress,started.Id);}catch(Exception closing){journal["closeFailure"]=closing.Message;UpgradePhase(journal,"recovery-required-private-data-retained",locator);throw new Exception("The updated application is still closing. Private data and the previous application are retained; run this installer again after it closes.",failure);}}
    if(promoted||Directory.Exists(Path.Combine(transaction,"application-before")))UpgradeRollback(journal,locator);else{UpgradePhase(journal,"not-installed-private-data-retained",locator);File.Delete(locator);}
    if(running&&Directory.Exists(destination)){try{using(var resumed=UpgradeStart(destination))UpgradeWaitReady(instance,resumed);}catch(Exception resume){throw new Exception("Private data and previous application retained. Reopen CodexControl; restart did not acknowledge readiness: "+resume.Message,failure);}}
    throw;
   }finally{if(started!=null)started.Dispose();}
  }finally{if(held)mutex.ReleaseMutex();}}
 }
 static string UpgradeHashText(string text){using(var stream=new MemoryStream(Encoding.UTF8.GetBytes(text)))return Hash(stream);}
}

static class InstallerDictionaryCompatibility {
 internal static bool TryAddCompat(this Dictionary<string,string> target,string key,string value){if(target.ContainsKey(key))return false;target.Add(key,value);return true;}
}
