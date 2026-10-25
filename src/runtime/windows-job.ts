import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';

interface Command { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }

/** Disable PowerShell's disk cache before startup, including sparse environments. */
export function windowsPowerShellEnv<T>(env: Record<string, T>): Record<string, T | string> {
  // Windows names are case-insensitive; remove every caller spelling before
  // setting the process-scoped value so a duplicate key cannot redirect it.
  const entries = Object.entries(env).filter(([name]) => name.toLowerCase() !== 'psmoduleanalysiscachepath');
  return { ...Object.fromEntries(entries), PSModuleAnalysisCachePath: 'NUL' };
}

// Built-in Windows PowerShell compiles this small controller in memory. The
// native process is suspended until it belongs to a non-breakaway Job Object.
// Only its three protocol pipes are inherited; neither the job nor the shutdown
// event can leak into descendants and prevent kill-on-close cleanup.
const controller = String.raw`
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HarnessWindowsJob {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int cb; public string reserved, desktop, title; public uint x,y,width,height,xChars,yChars,fill,flags; public short show,reservedBytes; public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint processLimit; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref LIMIT data,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNT data,int size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSA,IntPtr threadSA,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool okay) { if(!okay) throw new IOException("Windows process ownership operation failed"); }
  static void Close(ref IntPtr handle) { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
  static string Quote(string value) {
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='\"') { result.Append('\\',slashes*2+1); result.Append(c); } else { result.Append('\\',slashes); result.Append(c); } slashes=0; }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  static Thread Relay(Stream source,Stream target,bool closeTarget) {
    var thread=new Thread(delegate() { try { var buffer=new byte[16384]; int count; while((count=source.Read(buffer,0,buffer.Length))>0) { target.Write(buffer,0,count); target.Flush(); } } catch {} finally { try { source.Dispose(); } catch {} if(closeTarget) try { target.Dispose(); } catch {} } });
    thread.IsBackground=true; thread.Start(); return thread;
  }
  public static int Run(string bin,string[] args,string cwd,string eventName,uint parentPid) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,inRead=IntPtr.Zero,inWrite=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero;
    PI child=new PI(); bool assigned=false;
    try {
      using(var stop=new EventWaitHandle(false,EventResetMode.ManualReset,eventName)) {
        parent=OpenProcess(0x00100000,false,parentPid); Check(parent!=IntPtr.Zero);
        job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
        var limits=new LIMIT(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(LIMIT))));
        var sa=new SA(); sa.length=Marshal.SizeOf(typeof(SA)); sa.inherit=true;
        Check(CreatePipe(out inRead,out inWrite,ref sa,16384)); Check(CreatePipe(out outRead,out outWrite,ref sa,16384)); Check(CreatePipe(out errRead,out errWrite,ref sa,16384));
        Check(SetHandleInformation(inWrite,1,0)); Check(SetHandleInformation(outRead,1,0)); Check(SetHandleInformation(errRead,1,0));
        IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,1,0,ref size));
        handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,inRead); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);
        Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
        var start=new SIX(); start.startup.cb=Marshal.SizeOf(typeof(SIX)); start.startup.flags=0x100; start.startup.input=inRead; start.startup.output=outWrite; start.startup.error=errWrite; start.attributes=attributes;
        var command=new StringBuilder(Quote(bin)); foreach(string arg in args) command.Append(" ").Append(Quote(arg));
        Check(CreateProcess(bin,command,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref start,out child));
        Check(AssignProcessToJobObject(job,child.process)); assigned=true; Check(ResumeThread(child.thread)!=0xffffffff); Close(ref child.thread);
        Close(ref inRead); Close(ref outWrite); Close(ref errWrite);
        var input=new FileStream(new SafeFileHandle(inWrite,true),FileAccess.Write,16384,false); inWrite=IntPtr.Zero;
        var output=new FileStream(new SafeFileHandle(outRead,true),FileAccess.Read,16384,false); outRead=IntPtr.Zero;
        var error=new FileStream(new SafeFileHandle(errRead,true),FileAccess.Read,16384,false); errRead=IntPtr.Zero;
        var inputEnded=new ManualResetEvent(false);
        var stdin=new Thread(delegate() { try { using(var source=Console.OpenStandardInput()) { var buffer=new byte[16384]; int count; while((count=source.Read(buffer,0,buffer.Length))>0) { input.Write(buffer,0,count); input.Flush(); } } } catch {} finally { try { input.Dispose(); } catch {} inputEnded.Set(); } }); stdin.IsBackground=true; stdin.Start();
        var stdout=Relay(output,Console.OpenStandardOutput(),false); var stderr=Relay(error,Console.OpenStandardError(),false);
        while(!stop.WaitOne(10) && !inputEnded.WaitOne(0) && WaitForSingleObject(child.process,0)==258 && WaitForSingleObject(parent,0)==258) {}
        Check(TerminateJobObject(job,1));
        bool empty=false; for(int i=0;i<400;i++) { ACCOUNT state; Check(QueryInformationJobObject(job,1,out state,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero)); if(state.active==0) { empty=true; break; } Thread.Sleep(10); }
        Check(empty); Check(stdout.Join(1000)); Check(stderr.Join(1000)); return 0;
      }
    } catch { Console.Error.WriteLine("Windows native process cleanup was not confirmed"); return 1; }
    finally {
      if(child.process!=IntPtr.Zero && !assigned) TerminateProcess(child.process,1);
      if(job!=IntPtr.Zero) TerminateJobObject(job,1);
      Close(ref child.thread); Close(ref child.process); Close(ref parent); Close(ref job);
      Close(ref inRead); Close(ref inWrite); Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite);
      if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); } if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
    }
  }
}
`;

const encoded = (script: string): string[] => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
/** Shared trusted Win32 declarations; standalone processes add a direct-console entrypoint. */
export const windowsJobController = controller;

export function windowsJob(command: Command): { command: Command; signal: () => Promise<void> } {
  const eventName = `Local\\CodexHarness-${randomUUID()}`;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'\ntry {\n$c=$env:HARNESS_WINDOWS_JOB_COMMAND | ConvertFrom-Json\nRemove-Item Env:HARNESS_WINDOWS_JOB_COMMAND\nAdd-Type -TypeDefinition @'\n${controller}\n'@\nexit [HarnessWindowsJob]::Run([string]$c.bin,[string[]]$c.args,[string]$c.cwd,[string]$c.eventName,[uint32]$c.parentPid)\n} catch { [Console]::Error.WriteLine('Windows native launcher failed'); exit 1 }`;
  const env = windowsPowerShellEnv({ ...command.env, SystemRoot: systemRoot, HARNESS_WINDOWS_JOB_COMMAND: JSON.stringify({ bin: command.bin, args: command.args, cwd: command.cwd, eventName, parentPid: process.pid }) });
  return { command: { bin: powershell, args: encoded(script), cwd: command.cwd, env }, signal: () => new Promise<void>((resolve, reject) => {
    // A separate named event remains responsive while the protocol stdin is
    // backpressured. The event name contains only our generated UUID.
    const stop = `$ErrorActionPreference='Stop'; for($i=0;$i -lt 30;$i++){try{$e=[Threading.EventWaitHandle]::OpenExisting('${eventName}');[void]$e.Set();$e.Dispose();exit 0}catch{Start-Sleep -Milliseconds 100}};exit 1`;
    execFile(powershell, encoded(stop), { env: windowsPowerShellEnv({ SystemRoot: systemRoot }), cwd: systemRoot, windowsHide: true, timeout: 5000, maxBuffer: 1024 }, error => { if (error) reject(new Error('Windows native shutdown signal was not acknowledged')); else resolve(); });
  }) };
}
