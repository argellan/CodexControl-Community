// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Local-only records contain fixed categories, never raw process output.
sealed class CrashEvidence {
 const int MaxBytes=65536, MaxFiles=4, MaxOutputEventsPerSecond=20;
 readonly string file,correlation,build;
 readonly object sync=new object();
 readonly JavaScriptSerializer json=new JavaScriptSerializer();
 long second=-1;
 int admitted,dropped;
 public string Correlation { get { return correlation; } }
 public string Build { get { return build; } }
 public CrashEvidence(string directory,string buildId) {
  file=Path.Combine(directory,"launcher.jsonl");correlation=Guid.NewGuid().ToString("D");
  build=buildId;
 }
 void CheckFile(string name) {
  if(File.Exists(name)&&(File.GetAttributes(name)&FileAttributes.ReparsePoint)!=0)throw new IOException("Diagnostic link refused");
 }
 void Append(string kind,string stream,string category,int? exitCode,int? droppedCount) {
  try {
   var item=new Dictionary<string,object>{{"timestamp",DateTime.UtcNow.ToString("o")},{"applicationVersion","0.1.0"},
    {"buildId",build},{"correlationId",correlation},{"kind",kind}};
   if(stream!=null)item["stream"]=stream;if(category!=null)item["category"]=category;
   if(exitCode.HasValue)item["exitCode"]=exitCode.Value;
   if(droppedCount.HasValue)item["suppressedCount"]=droppedCount.Value;
   if(kind=="process-exit")item["signal"]="unavailable";
   var bytes=Encoding.UTF8.GetBytes(json.Serialize(item)+"\n");
   if(bytes.Length>MaxBytes)return;
   CheckFile(file);long length=File.Exists(file)?new FileInfo(file).Length:0;
   if(length+bytes.Length>MaxBytes) {
    string oldest=file+"."+(MaxFiles-1);CheckFile(oldest);if(File.Exists(oldest))File.Delete(oldest);
    for(int index=MaxFiles-2;index>=1;index--) {
     string from=file+"."+index,to=file+"."+(index+1);CheckFile(from);CheckFile(to);
     if(File.Exists(from))File.Move(from,to);
    }
    File.Move(file,file+".1");
   }
   using(var output=new FileStream(file,FileMode.Append,FileAccess.Write,FileShare.Read)) {output.Write(bytes,0,bytes.Length);output.Flush();}
  } catch { /* Diagnostic I/O must not block application startup or shutdown. */ }
 }
 void FlushDropped() {if(dropped>0){Append("output-summary",null,"output-suppressed",null,dropped);dropped=0;}}
 public void Start() {lock(sync)Append("launch",null,null,null,null);}
 public void StartFailure() {lock(sync)Append("launch-failure",null,"child-start-failed",null,null);}
 public void Output(string stream,string text,bool truncated) {
  lock(sync) {
   long now=DateTime.UtcNow.Ticks/TimeSpan.TicksPerSecond;
   if(now!=second){FlushDropped();second=now;admitted=0;}
   if(admitted++>=MaxOutputEventsPerSecond){if(dropped<Int32.MaxValue)dropped++;return;}
   string category=truncated?"line-truncated":"output-suppressed";
   if(!truncated&&stream=="stderr"&&text=="Local archive pending; original rows retained for retry.")category="archive-pending";
   else if(!truncated&&stream=="stderr"&&text=="COMMUNITY_STARTUP_FAILED: private setup/runtime evidence retained; no credentials printed.")category="startup-failed";
   else if(!truncated&&stream=="stderr"&&text=="COMMUNITY_STOP_FAILED: durable shutdown did not complete; private data remains in place.")category="shutdown-failed";
   else if(!truncated&&stream=="stdout"&&text=="COMMUNITY_STOPPED_DATA_PRESERVED")category="clean-stop";
   Append("output",stream=="stderr"?"stderr":"stdout",category,null,null);
  }
 }
 public void Exit(int code) {lock(sync){FlushDropped();Append("process-exit",null,null,code,null);}}
 public void ConsoleDropped(string stream,int count) {if(count>0)lock(sync)Append("output-summary",stream,"console-backpressure",null,count);}
}

sealed class BoundedConsoleForwarder {
 readonly Queue<string> queue=new Queue<string>();
 readonly TextWriter writer;
 readonly int capacity;
 readonly Thread thread;
 bool finished;
 int dropped;
 public int Dropped {get {lock(queue)return dropped;}}
 public BoundedConsoleForwarder(TextWriter output,int limit) {
  writer=output;capacity=limit;
  thread=new Thread(()=>{
   while(true) {
    string line;
    lock(queue) {
     while(queue.Count==0&&!finished)Monitor.Wait(queue);
     if(queue.Count==0&&finished)return;
     line=queue.Dequeue();
    }
    try{writer.WriteLine(line);}catch{}
   }
  });
  thread.IsBackground=true;thread.Start();
 }
 public void Enqueue(string line) {
  lock(queue) {
   if(finished||queue.Count>=capacity){if(dropped<Int32.MaxValue)dropped++;return;}
   queue.Enqueue(line.Length>8192?"[Long runtime output suppressed]":line);Monitor.Pulse(queue);
  }
 }
 public void Complete() {lock(queue){finished=true;Monitor.PulseAll(queue);}}
 public bool Join(int milliseconds) {return thread.Join(milliseconds);}
}

static class BoundedOutputPump {
 const int MaxLine=8192;
 public static Thread Start(StreamReader reader,Action<string,bool> accept) {
  var thread=new Thread(()=>{
   var line=new StringBuilder(MaxLine);bool truncated=false;
   Action flush=()=>{
    if(line.Length>0&&line[line.Length-1]=='\r')line.Length--;
    try{accept(line.ToString(),truncated);}catch{}
    line.Length=0;truncated=false;
   };
   try {
    int next;
    while((next=reader.Read())>=0) {
     char value=(char)next;
     if(value=='\n'){flush();continue;}
     if(line.Length<MaxLine)line.Append(value);else truncated=true;
    }
    if(line.Length>0||truncated)flush();
   } catch(IOException){}catch(ObjectDisposedException){}
  });
  thread.IsBackground=true;thread.Start();return thread;
 }
}
