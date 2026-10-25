import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { windowsJobController, windowsPowerShellEnv } from './windows-job.js';

const entrypoint = String.raw`
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
  public static int RunProcess(string bin,string[] args,string cwd,string eventName,uint parentPid,string pipeName,string token) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero; PI child=new PI(); bool assigned=false;
    try {
      using(var pipe=new System.IO.Pipes.NamedPipeClientStream(".",pipeName,System.IO.Pipes.PipeDirection.Out)) {
        pipe.Connect(5000);
        using(var control=new StreamWriter(pipe,new UTF8Encoding(false),1024)) {
          control.AutoFlush=true;
          using(var stop=new EventWaitHandle(false,EventResetMode.ManualReset,eventName)) {
            parent=OpenProcess(0x00100000,false,parentPid); Check(parent!=IntPtr.Zero);
            job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
            var limits=new LIMIT(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(LIMIT))));
            IntPtr input=GetStdHandle(-10),output=GetStdHandle(-11),error=GetStdHandle(-12);
            Check(input!=IntPtr.Zero && input!=new IntPtr(-1) && output!=IntPtr.Zero && output!=new IntPtr(-1) && error!=IntPtr.Zero && error!=new IntPtr(-1));
            Check(SetHandleInformation(input,1,1)); Check(SetHandleInformation(output,1,1)); Check(SetHandleInformation(error,1,1));
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,1,0,ref size));
            handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output); Marshal.WriteIntPtr(handles,IntPtr.Size*2,error);
            Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
            var start=new SIX(); start.startup.cb=Marshal.SizeOf(typeof(SIX)); start.startup.flags=0x100; start.startup.input=input; start.startup.output=output; start.startup.error=error; start.attributes=attributes;
            var command=new StringBuilder(Quote(bin)); foreach(string arg in args) command.Append(" ").Append(Quote(arg));
            // Inherit the existing console/ConPTY, including its real terminal handles.
            Check(CreateProcess(bin,command,IntPtr.Zero,IntPtr.Zero,true,0x00080004,IntPtr.Zero,cwd,ref start,out child));
            Check(AssignProcessToJobObject(job,child.process)); assigned=true; Check(ResumeThread(child.thread)!=0xffffffff); Close(ref child.thread);
            control.WriteLine("{\"token\":\""+token+"\",\"type\":\"started\",\"pid\":"+child.pid+"}");
            while(!stop.WaitOne(10) && WaitForSingleObject(child.process,0)==258 && WaitForSingleObject(parent,0)==258) {}
            uint exitCode; Check(GetExitCodeProcess(child.process,out exitCode));
            Check(TerminateJobObject(job,1)); bool empty=false;
            for(int i=0;i<400;i++) { ACCOUNT state; Check(QueryInformationJobObject(job,1,out state,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero)); if(state.active==0) { empty=true; break; } Thread.Sleep(10); }
            Check(empty); if(exitCode==259) Check(GetExitCodeProcess(child.process,out exitCode));
            control.WriteLine("{\"token\":\""+token+"\",\"type\":\"exited\",\"exitCode\":"+unchecked((int)exitCode)+"}"); return 0;
          }
        }
      }
    } catch { Console.Error.WriteLine("Windows process ownership cleanup was not confirmed"); return 1; }
    finally {
      if(child.process!=IntPtr.Zero && !assigned) TerminateProcess(child.process,1); if(job!=IntPtr.Zero) TerminateJobObject(job,1);
      Close(ref child.thread); Close(ref child.process); Close(ref parent); Close(ref job);
      if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); } if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
    }
  }
`;
const controller = windowsJobController.slice(0, windowsJobController.indexOf('  public static int Run(')) + entrypoint + '\n}';
const encoded = (script: string): string[] => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
export interface WindowsProcessJob { command: string[]; env: Record<string, string>; started: Promise<number>; exited: Promise<number>; signal(): Promise<void>; dispose(): void }

/** A separate control pipe cannot lose cleanup evidence to stdout/stderr caps. */
export async function windowsProcessJob(command: string[], cwd: string): Promise<WindowsProcessJob> {
  const id = randomUUID(), token = randomUUID(), pipeName = `CodexHarnessProcess-${id}`, eventName = `Local\\CodexHarnessProcess-${id}`;
  let ready!: (pid: number) => void, finished!: (code: number) => void, rejectReady!: (error: Error) => void, rejectFinished!: (error: Error) => void;
  const started = new Promise<number>((resolve, reject) => { ready = resolve; rejectReady = reject; }); const exited = new Promise<number>((resolve, reject) => { finished = resolve; rejectFinished = reject; }); void started.catch(() => {}); void exited.catch(() => {});
  let socket: Socket | undefined; let done = false; let running = false; let input = Buffer.alloc(0); let startupTimer: NodeJS.Timeout;
  const failed = (): void => { if (done) return; done = true; clearTimeout(startupTimer); const error = new Error('Windows process cleanup proof was lost'); rejectReady(error); rejectFinished(error); socket?.destroy(); server.close(); };
  const server = createServer(incoming => {
    if (socket || done) { incoming.destroy(); return; } socket = incoming; server.close(); incoming.on('error', failed); incoming.on('close', () => { if (!done) failed(); });
    incoming.on('data', bytes => {
      if (input.length + bytes.length > 2048) { failed(); return; } input = Buffer.concat([input, bytes]);
      for (;;) { const index = input.indexOf(10); if (index < 0) break; const line = input.subarray(0, index).toString('utf8'); input = input.subarray(index + 1);
        try { const message = JSON.parse(line) as { token?: unknown; type?: unknown; pid?: unknown; exitCode?: unknown }; if (message.token !== token) throw new Error();
          if (message.type === 'started' && !running && typeof message.pid === 'number' && Number.isSafeInteger(message.pid) && message.pid > 0) { running = true; clearTimeout(startupTimer); ready(message.pid); }
          else if (message.type === 'exited' && running && typeof message.exitCode === 'number' && Number.isInteger(message.exitCode) && message.exitCode >= -2147483648 && message.exitCode <= 2147483647) { done = true; clearTimeout(startupTimer); finished(message.exitCode); incoming.end(); }
          else throw new Error();
        } catch { failed(); return; }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${pipeName}`, () => { server.off('error', reject); server.on('error', failed); resolve(); }); });
  startupTimer = setTimeout(failed, 15000); startupTimer.unref();
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'; const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\ntry {\n$c=$env:HARNESS_WINDOWS_PROCESS_COMMAND | ConvertFrom-Json\nRemove-Item Env:HARNESS_WINDOWS_PROCESS_COMMAND\n$target=(Get-Command -Name ([Management.Automation.WildcardPattern]::Escape([string]$c.bin)) -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source\nAdd-Type -TypeDefinition @'\n${controller}\n'@\nexit [HarnessWindowsJob]::RunProcess([string]$target,[string[]]$c.args,[string]$c.cwd,[string]$c.eventName,[uint32]$c.parentPid,[string]$c.pipeName,[string]$c.token)\n} catch { [Console]::Error.WriteLine('Windows process launcher failed'); exit 1 }`;
  return { command: [powershell, ...encoded(script)], env: windowsPowerShellEnv({ SystemRoot: systemRoot, HARNESS_WINDOWS_PROCESS_COMMAND: JSON.stringify({ bin: command[0], args: command.slice(1), cwd, eventName, parentPid: process.pid, pipeName, token }) }), started, exited,
    signal: () => new Promise<void>((resolve, reject) => { if (done) { resolve(); return; } const script = `$ErrorActionPreference='Stop';$e=[Threading.EventWaitHandle]::OpenExisting('${eventName}');[void]$e.Set();$e.Dispose()`; execFile(powershell, encoded(script), { env: windowsPowerShellEnv({ SystemRoot: systemRoot }), cwd: systemRoot, timeout: 5000, maxBuffer: 1024, windowsHide: true }, error => error && !done ? reject(new Error('Windows process shutdown signal failed')) : resolve()); }),
    dispose: () => { if (!done) failed(); else { clearTimeout(startupTimer); socket?.destroy(); server.close(); } },
  };
}
