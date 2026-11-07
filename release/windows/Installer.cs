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
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Net;
using System.Net.Sockets;
using System.Threading;
[assembly: AssemblyTitle("CodexControl Community Setup")]
[assembly: AssemblyCompany("ARGELLAN")]
[assembly: AssemblyProduct("CodexControl Community")]
[assembly: AssemblyVersion("0.1.0.0")]
static class Installer {
 const string Version="0.1.0";
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=8388608 };
 static string OwnExe { get { return Assembly.GetExecutingAssembly().Location; } }
 static string Quote(string value) { if(value.IndexOf('"')>=0 || value.IndexOf('\0')>=0)throw new Exception("Invalid argument");return "\""+value+"\""; }
 static string Hash(Stream input) { using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(input)).Replace("-","").ToLowerInvariant(); }
 static string Read(Stream input) { using(var reader=new StreamReader(input,Encoding.UTF8,true,4096,true))return reader.ReadToEnd(); }
 static string RealLocal(string raw) {
  if(String.IsNullOrWhiteSpace(raw)||!Path.IsPathRooted(raw)||raw.StartsWith(@"\\")||raw.StartsWith("//"))throw new Exception("Absolute local disk path required");
  var full=Path.GetFullPath(raw).TrimEnd(Path.DirectorySeparatorChar);
  if(full.Length<4||new DriveInfo(Path.GetPathRoot(full)).DriveType!=DriveType.Fixed)throw new Exception("Fixed local disk required");
  string walk=full;
  while(!String.IsNullOrEmpty(walk)) { if((Directory.Exists(walk)||File.Exists(walk))&&(File.GetAttributes(walk)&FileAttributes.ReparsePoint)!=0)throw new Exception("Links and junctions refused");walk=Path.GetDirectoryName(walk); }
  return full;
 }
 static string Member(string name) {
  if(String.IsNullOrEmpty(name)||name.Length>230||name.StartsWith("/")||name.IndexOfAny(new char[]{'\\',':','<','>','|','"','*','?'})>=0||name.Any(c=>c<32))throw new Exception("Unsafe payload member");
  foreach(var part in name.Split('/')) { if(part.Length==0||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" "))throw new Exception("Unsafe payload segment");var stem=part.Split('.')[0].ToUpperInvariant();if(new[]{"CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"}.Contains(stem))throw new Exception("Reserved payload name"); }
  return name;
 }
 static void AssertPrivateDescriptor(DirectorySecurity acl,SecurityIdentifier owner) {
  if(!acl.AreAccessRulesProtected||!owner.Equals(acl.GetOwner(typeof(SecurityIdentifier))))throw new InvalidOperationException("Private directory owner/inheritance mismatch");
  var system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);var seen=new HashSet<string>();
  foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
   var sid=(SecurityIdentifier)rule.IdentityReference;
   if(rule.IsInherited||rule.AccessControlType!=AccessControlType.Allow||!sid.Equals(owner)&&!sid.Equals(system)||rule.FileSystemRights!=FileSystemRights.FullControl||rule.InheritanceFlags!=(InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit)||rule.PropagationFlags!=PropagationFlags.None||!seen.Add(sid.Value))throw new InvalidOperationException("Private directory DACL mismatch");
  }
  if(seen.Count!=2)throw new InvalidOperationException("Private directory DACL incomplete");
 }
 static void PrivateDirectory(string path) {
  Directory.CreateDirectory(path);var owner=WindowsIdentity.GetCurrent().User;var directory=new DirectoryInfo(path);
  // New per-user directory already has this owner. Do not request WRITE_OWNER
  // merely to persist the same SID; ownership is checked before and after.
  if(!owner.Equals(directory.GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier))))throw new InvalidOperationException("New directory is not owned by the current Windows user");
  var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);
  foreach(var sid in new[]{owner,new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null)})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
  directory.SetAccessControl(acl);
  AssertPrivateDescriptor(directory.GetAccessControl(AccessControlSections.Access|AccessControlSections.Owner),owner);
 }
 static string DefaultHome() {
  // AppData may grant application-capability write access on this host. A safe
  // profile ancestor is validated; no existing descriptor is repaired or relaxed.
  return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),"ARGELLAN","CodexControl-Community");
 }
 static void AssertSafeAncestorDescriptor(DirectorySecurity acl,SecurityIdentifier current,bool volumeRoot) {
  var system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);var admins=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);
  var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
  bool osRoot=volumeRoot&&owner.Value=="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  bool normalOwner=current.Equals(owner)||system.Equals(owner)||admins.Equals(owner);
  if(!normalOwner&&!osRoot)throw new InvalidOperationException("Unsafe destination ancestor owner");
  var raw=new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(),0);
  if(raw.DiscretionaryAcl==null||raw.DiscretionaryAcl.Count>1024)throw new InvalidOperationException("Unsafe destination ancestor DACL");
  foreach(GenericAce ace in raw.DiscretionaryAcl)if(ace.AceType!=AceType.AccessAllowed&&ace.AceType!=AceType.AccessDenied)throw new InvalidOperationException("Unsupported destination ancestor ACE");
  foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
   if(rule.AccessControlType!=AccessControlType.Allow||(rule.PropagationFlags&PropagationFlags.InheritOnly)!=0)continue;
   var sid=(SecurityIdentifier)rule.IdentityReference;uint mask=unchecked((uint)(int)rule.FileSystemRights);
   if(!current.Equals(sid)&&!system.Equals(sid)&&!admins.Equals(sid)&&!(normalOwner&&sid.Value=="S-1-3-4")&&(mask&0x500D0040U)!=0)throw new InvalidOperationException("Unsafe destination ancestor permits replacement; choose a private profile path");
  }
 }
 static void SafeAncestors(string path) {
  var full=Path.GetFullPath(path);var root=Path.GetPathRoot(full);var drive=new DriveInfo(root);
  if(drive.DriveType!=DriveType.Fixed||!String.Equals(drive.DriveFormat,"NTFS",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Destination requires fixed local NTFS");
  string walk=full;int depth=0;
  while(!String.IsNullOrEmpty(walk)) {
   if(++depth>32||!Directory.Exists(walk)||(File.GetAttributes(walk)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("Unsafe destination ancestor");
   bool volumeRoot=String.Equals(walk.TrimEnd('\\'),root.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase);
   AssertSafeAncestorDescriptor(new DirectoryInfo(walk).GetAccessControl(AccessControlSections.Access|AccessControlSections.Owner),WindowsIdentity.GetCurrent().User,volumeRoot);
   walk=Path.GetDirectoryName(walk);
  }
 }
 static string ExistingParent(string target) {
  string walk=Path.GetDirectoryName(target);
  while(!Directory.Exists(walk)){if(String.IsNullOrEmpty(walk)||File.Exists(walk))throw new InvalidOperationException("Destination parent refused");walk=Path.GetDirectoryName(walk);}
  SafeAncestors(walk);return walk;
 }
 static void PrepareParents(string target) {
  var missing=new Stack<string>();string walk=Path.GetDirectoryName(target);
  while(!Directory.Exists(walk)){missing.Push(walk);walk=Path.GetDirectoryName(walk);}
  SafeAncestors(walk);
  foreach(var next in missing){if(!Directory.Exists(next))PrivateDirectory(next);SafeAncestors(next);}
 }
 static int Run(string exe, string arguments, string cwd, bool visible, int timeout) {
  var start=new ProcessStartInfo(exe,arguments){UseShellExecute=false,WorkingDirectory=cwd,CreateNoWindow=!visible};
  start.EnvironmentVariables.Remove("NODE_OPTIONS");start.EnvironmentVariables.Remove("NODE_PATH");start.EnvironmentVariables.Remove("PYTHONPATH");start.EnvironmentVariables.Remove("PYTHONHOME");
  using(var child=Process.Start(start)) { if(timeout==0){child.WaitForExit();return child.ExitCode;}if(!child.WaitForExit(timeout)){if(!child.HasExited)child.Kill();throw new Exception("Owned setup process timeout");}return child.ExitCode; }
 }
 static bool LocalPortAvailable(int port) {
  var probe=new TcpListener(IPAddress.Loopback,port);probe.ExclusiveAddressUse=true;
  try{probe.Start();return true;}catch(SocketException){return false;}finally{probe.Stop();}
 }
 static int DefaultPort() {
  if(LocalPortAvailable(4317))return 4317;
  for(int attempt=0;attempt<8;attempt++){
   var probe=new TcpListener(IPAddress.Loopback,0);probe.ExclusiveAddressUse=true;
   try{probe.Start();int port=((IPEndPoint)probe.LocalEndpoint).Port;if(port<65535)return port;}finally{probe.Stop();}
  }
  throw new Exception("No available local dashboard port");
 }
 static bool SameDashboard(string origin,string instanceId) {
  try{
   var request=(HttpWebRequest)WebRequest.Create(origin+"/api/identity");request.Proxy=null;request.AllowAutoRedirect=false;request.Timeout=750;request.ReadWriteTimeout=750;
   using(var response=(HttpWebResponse)request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream())){
    var buffer=new char[8193];int count=0,n;while(count<buffer.Length&&(n=reader.Read(buffer,count,buffer.Length-count))>0)count+=n;
    if(response.StatusCode!=HttpStatusCode.OK||count==buffer.Length)return false;
    var identity=Json.Deserialize<Dictionary<string,object>>(new string(buffer,0,count));object value;
    return identity.TryGetValue("deploymentId",out value)&&String.Equals(value as string,instanceId,StringComparison.Ordinal);
   }
  }catch{return false;}
 }
 static string DashboardOrigin(string instance) {
  var hub=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(instance,"hub.json")));
  string origin=(string)hub["publicOrigin"];
  var configuration=Path.Combine(instance,@"data\configuration\configuration.json");
  if(File.Exists(configuration)){
   var state=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(configuration));
   var settings=(Dictionary<string,object>)state["configuration"];var network=(Dictionary<string,object>)settings["networking"];
   object configured;if(network.TryGetValue("publicOrigin",out configured)&&configured is string&&!String.IsNullOrEmpty((string)configured))origin=(string)configured;
  }
  var uri=new Uri(origin,UriKind.Absolute);
  if(!String.IsNullOrEmpty(uri.UserInfo)||uri.AbsolutePath!="/"||!String.IsNullOrEmpty(uri.Query)||!String.IsNullOrEmpty(uri.Fragment)||(uri.Scheme!="https"&&(uri.Scheme!="http"||!uri.IsLoopback)))throw new Exception("Invalid dashboard address");
  return uri.GetLeftPart(UriPartial.Authority);
 }
 static void OpenDashboard(string origin){Process.Start(new ProcessStartInfo(origin){UseShellExecute=true});}
 static string DashboardInstance(string instance){var hub=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(instance,"hub.json")));return (string)hub["instanceId"];}
 static bool InitialPasswordRequired(string instance){
  var file=Path.Combine(instance,@"data\administration\administration.json");if(!File.Exists(file))return false;
  var state=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
  foreach(Dictionary<string,object> user in (System.Collections.IEnumerable)state["viewers"]){object required;if(Equals(user["id"],"owner")&&user.TryGetValue("passwordChangeRequired",out required))return Equals(required,true);}return false;
 }
 static bool ShowInitialSignIn(string instance){
  if(!InitialPasswordRequired(instance))return true;
  var envelope=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(instance,"first-sign-in.json")));
  string identity=DashboardInstance(instance);if(!Equals(envelope["instanceId"],identity))throw new Exception("Initial account identity differs from this installation");
  var secret=ProtectedData.Unprotect(Convert.FromBase64String((string)envelope["protectedCredentials"]),Encoding.UTF8.GetBytes("ARGELLAN/CodexControl/first-sign-in/v1/"+identity),DataProtectionScope.CurrentUser);
  Dictionary<string,object> credential;try{credential=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(secret));}finally{Array.Clear(secret,0,secret.Length);}
  Application.EnableVisualStyles();using(var form=new Form{Text="Your CodexControl account",Width=680,Height=370,StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,AutoScaleMode=AutoScaleMode.Font,Font=new System.Drawing.Font("Segoe UI",10),AccessibleName="Initial CodexControl account"}){
   var heading=new Label{Left=24,Top=20,Width=610,Height=54,Text="Your account is ready.\r\nUse this password once, then choose your own after signing in."};
   var userLabel=new Label{Left=24,Top=90,Width=120,Text="Username"};var username=new TextBox{Left=160,Top=86,Width=465,ReadOnly=true,Text=(string)credential["username"],TabIndex=0,AccessibleName="Default username"};
   var passLabel=new Label{Left=24,Top=136,Width=130,Height=42,Text="Temporary\r\npassword"};var password=new TextBox{Left=160,Top=136,Width=465,ReadOnly=true,Text=(string)credential["password"],UseSystemPasswordChar=true,TabIndex=1,AccessibleName="Unique temporary password"};
   var show=new CheckBox{Left=160,Top=178,Width=210,Height=36,Text="Show password",TabIndex=2,AccessibleName="Show temporary password"};show.CheckedChanged+=(s,e)=>password.UseSystemPasswordChar=!show.Checked;
   var copy=new Button{Left=410,Top=178,Width=215,Height=44,Text="Copy password",TabIndex=3};copy.Click+=(s,e)=>{try{Clipboard.SetText(password.Text);copy.Text="Copied";}catch{copy.Text="Select password to copy";password.UseSystemPasswordChar=false;password.SelectAll();password.Focus();}};
   var open=new Button{Left=410,Top=258,Width=215,Height=44,Text="Open sign-in",DialogResult=DialogResult.OK,TabIndex=4};var later=new Button{Left=250,Top=258,Width=140,Height=44,Text="Later",DialogResult=DialogResult.Cancel,TabIndex=5};
   form.AcceptButton=open;form.CancelButton=later;form.Controls.AddRange(new Control[]{heading,userLabel,username,passLabel,password,show,copy,open,later});return form.ShowDialog()==DialogResult.OK;
  }
 }
 static void Payload(string destination) {
  using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
   if(stream==null)throw new Exception("Embedded payload missing");
   using(var zip=new ZipArchive(stream,ZipArchiveMode.Read)) {
    var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach(var entry in zip.Entries){Member(entry.FullName);if(!names.Add(entry.FullName)||((entry.ExternalAttributes>>16)&0xF000)==0xA000)throw new Exception("Duplicate or linked payload");}
    var metadata=zip.GetEntry("INSTALLER_MANIFEST.json");if(metadata==null||metadata.Length>8388608)throw new Exception("Payload manifest missing");
    Dictionary<string,object> manifest;using(var input=metadata.Open())manifest=Json.Deserialize<Dictionary<string,object>>(Read(input));
    if((string)manifest["version"]!=Version||(string)manifest["platform"]!="win32-x64")throw new Exception("Payload identity mismatch");
    var files=((System.Collections.IEnumerable)manifest["files"]).Cast<Dictionary<string,object>>().ToArray();if(files.Length+1!=zip.Entries.Count)throw new Exception("Unexpected payload member count");
    var covered=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach(Dictionary<string,object> row in files) {
     var relative=Member((string)row["path"]);if(!covered.Add(relative))throw new Exception("Repeated manifest path");
     var entry=zip.GetEntry(relative);if(entry==null||entry.Length!=Convert.ToInt64(row["bytes"]))throw new Exception("Payload size mismatch");
     using(var input=entry.Open())if(Hash(input)!=(string)row["sha256"])throw new Exception("Payload hash mismatch");
    }
    if(destination==null){Console.WriteLine("PAYLOAD_VERIFIED "+files.Length+" files; Community "+Version+" win32-x64");return;}
    foreach(Dictionary<string,object> row in files) {
     var relative=(string)row["path"];var target=Path.GetFullPath(Path.Combine(destination,relative.Replace('/',Path.DirectorySeparatorChar)));
     if(!target.StartsWith(destination+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Payload containment failed");
     Directory.CreateDirectory(Path.GetDirectoryName(target));using(var input=zip.GetEntry(relative).Open())using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None))input.CopyTo(output);
     using(var output=File.OpenRead(target))if(Hash(output)!=(string)row["sha256"])throw new Exception("Extracted payload mismatch");
    }
    using(var input=metadata.Open())using(var output=new FileStream(Path.Combine(destination,"INSTALLER_MANIFEST.json"),FileMode.CreateNew))input.CopyTo(output);
   }
  }
 }
 static void Install(Dictionary<string,string> args) {
  string destination=RealLocal(args["destination"]),instance=RealLocal(args["instance"]);
  if(destination.Equals(instance,StringComparison.OrdinalIgnoreCase)||instance.StartsWith(destination+"\\",StringComparison.OrdinalIgnoreCase)||destination.StartsWith(instance+"\\",StringComparison.OrdinalIgnoreCase))throw new Exception("Application and private instance must be separate");
  if(Directory.Exists(destination)||File.Exists(destination)||Directory.Exists(instance)||File.Exists(instance))throw new Exception("Existing app or instance preserved; fresh destination required");
  if(args.ContainsKey("test-only")&&!destination.Contains("TEST_ONLY"))throw new Exception("TEST_ONLY installation requires a visibly marked destination");
  int port=DefaultPort();if(args.ContainsKey("port")&&(!Int32.TryParse(args["port"],out port)||port<1024||port>65535))throw new Exception("Invalid port");
  if(!LocalPortAvailable(port))throw new Exception("The selected dashboard port is already in use. Existing applications were left running.");
  string role=args.ContainsKey("role")?args["role"]:"standalone";if(!new[]{"hub","node","standalone"}.Contains(role))throw new Exception("Choose Hub, Node or Standalone");
  string source=args.ContainsKey("session-root")?RealLocal(args["session-root"]):"";
  // Verify every embedded member before any extraction or credential generation.
  ExistingParent(destination);ExistingParent(instance);
  Payload(null);PrepareParents(destination);PrepareParents(instance);PrivateDirectory(destination);
  Payload(destination);
  File.Copy(OwnExe,Path.Combine(destination,"CodexControl-Community.exe"),false);
  var node=Path.Combine(destination,@"runtimes\node\node.exe");
  var bootstrap=Path.Combine(destination,@"app\scripts\windows-community.mjs");
  var command="--max-old-space-size=256 "+Quote(bootstrap)+" --initialize --instance="+Quote(instance)+" --port="+port+" --role="+role;
  if(source.Length>0)command+=" --session-root="+Quote(source);
  if(Run(node,command,destination,false,30000)!=0)throw new Exception("Private instance setup failed; extracted files retained");
  File.WriteAllText(Path.Combine(destination,"CE_INSTALLATION.json"),Json.Serialize(new {version=Version,instance=instance,application=destination,testOnly=args.ContainsKey("test-only"),role=role,dataRetention="preserved"}),Encoding.UTF8);
  if(!args.ContainsKey("no-shortcuts")) {
   var menu=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),"Programs","ARGELLAN CodexControl Community");Directory.CreateDirectory(menu);
   WriteLink(Path.Combine(menu,"CodexControl Community.lnk"),Path.Combine(destination,"CodexControl-Community.exe"));
  }
  Console.WriteLine("INSTALLED Community "+Version+"; private data retained outside application");
 }
 static void WriteLink(string file,string exe){
  object shell=null,shortcut=null;
  try {var type=Type.GetTypeFromProgID("WScript.Shell",true);shell=Activator.CreateInstance(type);shortcut=type.InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,new object[]{file});var t=shortcut.GetType();t.InvokeMember("TargetPath",BindingFlags.SetProperty,null,shortcut,new object[]{exe});t.InvokeMember("WorkingDirectory",BindingFlags.SetProperty,null,shortcut,new object[]{Path.GetDirectoryName(exe)});t.InvokeMember("Description",BindingFlags.SetProperty,null,shortcut,new object[]{"ARGELLAN CodexControl Community"});t.InvokeMember("Save",BindingFlags.InvokeMethod,null,shortcut,null);}
  finally {if(shortcut!=null)System.Runtime.InteropServices.Marshal.ReleaseComObject(shortcut);if(shell!=null)System.Runtime.InteropServices.Marshal.ReleaseComObject(shell);}
 }
 static void Launch(string root,bool openBrowser) {
  var metadata=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"CE_INSTALLATION.json")));
  var instance=RealLocal((string)metadata["instance"]);
  string instanceId=DashboardInstance(instance),origin=DashboardOrigin(instance);
  if(openBrowser&&!ShowInitialSignIn(instance))return;
  if(SameDashboard(origin,instanceId)){if(openBrowser)OpenDashboard(origin);return;}
  var address=new Uri(origin);if(address.IsLoopback&&!LocalPortAvailable(address.Port))throw new Exception("Dashboard port "+address.Port+" is already used by another application. Existing applications and your saved data were left untouched.");
  // Foreground owner process: Ctrl+C closes only this instance's runtime.
  var start=new ProcessStartInfo(Path.Combine(root,@"runtimes\node\node.exe"),"--max-old-space-size=256 "+Quote(Path.Combine(root,@"app\scripts\windows-community.mjs"))+" --run --instance="+Quote(instance)){UseShellExecute=false,WorkingDirectory=root,CreateNoWindow=false,RedirectStandardOutput=true};
  foreach(var name in new[]{"NODE_OPTIONS","NODE_PATH","PYTHONPATH","PYTHONHOME"})start.EnvironmentVariables.Remove(name);
  using(var child=new Process{StartInfo=start}){
   int opened=0;
   child.OutputDataReceived+=(sender,e)=>{if(e.Data==null)return;Console.WriteLine(e.Data);if(!openBrowser||!e.Data.StartsWith("{"))return;try{
    var ready=Json.Deserialize<Dictionary<string,object>>(e.Data);object status,id;
    if(ready.TryGetValue("status",out status)&&Equals(status,"COMMUNITY_READY")&&ready.TryGetValue("instanceId",out id)&&Equals(id,instanceId)&&SameDashboard(origin,instanceId)&&Interlocked.CompareExchange(ref opened,1,0)==0)OpenDashboard(origin);
   }catch{Console.Error.WriteLine("The dashboard is running at "+origin+". Open this address in your browser.");}};
   child.Start();child.BeginOutputReadLine();child.WaitForExit();
   if(child.ExitCode!=0)throw new Exception("Runtime stopped with exit "+child.ExitCode);
  }
 }
 static void Wizard() {
  Application.EnableVisualStyles();var form=new Form{Text="CodexControl Community 0.1.0 — ARGELLAN",Width=720,Height=410,StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,AutoScaleMode=AutoScaleMode.Font,Font=new System.Drawing.Font("Segoe UI",10),AccessibleName="CodexControl Community installer"};
  var label=new Label{Left=24,Top=20,Width=660,Height=80,Text="CodexControl Community for this computer\r\nStarts on this computer. Change Standalone, Hub or Node in Settings.\r\nNode.js, Python and local archive analytics are bundled."};
  var capture=new CheckBox{Left=24,Top=112,Width=660,Height=42,Text="Read my local Codex activity, quota and Dot (prompts and raw output excluded)",Checked=true,TabIndex=0,AccessibleName="Observe local Codex metadata"};
  var note=new Label{Left=24,Top=165,Width=660,Height=75,Text="Installs for this Windows user. Private captured history lives outside the application.\r\nChange this installation to Hub or Node from Settings when needed.\r\nLocal preview; release qualification remains separate."};
  var launch=new CheckBox{Left=24,Top=250,Width=620,Height=34,Text="Open CodexControl after installation",Checked=true,TabIndex=1};
  var install=new Button{Left=490,Top=300,Width=180,Height=44,Text="&Install Community",TabIndex=2};var cancel=new Button{Left=340,Top=300,Width=130,Height=44,Text="&Cancel",TabIndex=3};cancel.Click+=(s,e)=>form.Close();
  install.Click+=(s,e)=>{try{install.Enabled=false;var home=DefaultHome();var args=new Dictionary<string,string>{{"destination",Path.Combine(home,"app-0.1.0")},{"instance",Path.Combine(home,"instance")}};if(capture.Checked)args["session-root"]=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".codex","sessions");Install(args);if(launch.Checked)Process.Start(new ProcessStartInfo(Path.Combine(args["destination"],"CodexControl-Community.exe")){UseShellExecute=true});else ShowInitialSignIn(args["instance"]);form.Close();}catch(Exception error){MessageBox.Show(error.Message,"Installation stopped; existing data preserved");install.Enabled=true;}};
  form.AcceptButton=install;form.CancelButton=cancel;form.Controls.AddRange(new Control[]{label,capture,note,launch,install,cancel});Application.Run(form);
 }
 [STAThread] public static int Main(string[] argv) {
  try {
   var args=new Dictionary<string,string>(StringComparer.Ordinal);foreach(var raw in argv){if(!raw.StartsWith("--"))throw new Exception("Use documented named arguments");var pair=raw.Substring(2).Split(new[]{'='},2);if(args.ContainsKey(pair[0]))throw new Exception("Duplicate argument");args.Add(pair[0],pair.Length==2?pair[1]:"");}
   var allowed=new[]{"verify-payload","install","destination","instance","test-only","no-shortcuts","port","session-root","role","launch","no-browser","uninstall"};if(args.Keys.Any(k=>!allowed.Contains(k)))throw new Exception("Unknown argument");
   if(args.ContainsKey("verify-payload")){Payload(null);return 0;}
   if(args.ContainsKey("install")){Install(args);return 0;}
   var root=Path.GetDirectoryName(OwnExe);
   if(args.ContainsKey("uninstall")){if(!File.Exists(Path.Combine(root,"CE_INSTALLATION.json")))throw new Exception("Installed identity required");Console.WriteLine("DATA_PRESERVED: Close this app's console before removing its exact application folder. Private instance and archive are retained.");return 0;}
   if(args.ContainsKey("launch")||File.Exists(Path.Combine(root,"CE_INSTALLATION.json"))){Launch(root,!args.ContainsKey("no-browser"));return 0;}
   Wizard();return 0;
  } catch(Exception error){Console.Error.WriteLine("CODEXCONTROL_SETUP_FAILED: "+error.Message);if(argv.Length==0)MessageBox.Show(error.Message,"CodexControl could not start",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
 }
}
