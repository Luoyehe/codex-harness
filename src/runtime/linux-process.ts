import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import type { WindowsProcessJob } from './windows-process.js';

/** Standard Python only; child subreaping plus pidfds also owns setsid descendants. */
const controller = String.raw`
import ctypes, json, os, pathlib, select, signal, socket, subprocess, sys, time
spec=json.loads(os.environ.pop('HARNESS_LINUX_PROCESS_COMMAND'))
connection=None
child=None
stop=False
def stopped(*_):
    global stop
    stop=True
def children(pid,deadline=None):
    result=set()
    try:
        with os.scandir('/proc/%s/task'%pid) as tasks:
            for index,task in enumerate(tasks):
                if deadline is not None and time.monotonic()>deadline: raise RuntimeError('cleanup deadline')
                if index>=4096: raise RuntimeError('thread budget')
                try:
                    with open(task.path+'/children') as file: data=file.read(65537)
                    if len(data)>65536: raise RuntimeError('child list budget')
                    result.update(int(value) for value in data.split())
                    if len(result)>4096: raise RuntimeError('child budget')
                except FileNotFoundError: pass
    except FileNotFoundError: return []
    return list(result)
def parent_of(pid):
    try: return int(pathlib.Path('/proc/%s/stat'%pid).read_text().rsplit(')',1)[1].split()[1])
    except FileNotFoundError: return None
def cleanup():
    deadline=time.monotonic()+4
    while children(os.getpid(),deadline):
        if time.monotonic()>deadline: raise RuntimeError('cleanup deadline')
        queue=[(pid,os.getpid(),None) for pid in children(os.getpid(),deadline)]; seen=set(); held=[]
        try:
            while queue:
                pid,parent,parent_fd=queue.pop()
                if pid in seen: continue
                if len(seen)>=4096 or time.monotonic()>deadline: raise RuntimeError('cleanup budget')
                seen.add(pid)
                try:
                    fd=os.pidfd_open(pid,0)
                    # A numeric PID may have been reused since enumeration.
                    # The opened target must still descend from this subreaper
                    # or the live ancestor held by its already-owned pidfd.
                    ppid=parent_of(pid)
                    if ppid!=os.getpid() and (ppid!=parent or parent_fd is None or select.select([parent_fd],[],[],0)[0]):
                        os.close(fd)
                        continue
                    held.append(fd)
                    signal.pidfd_send_signal(fd,signal.SIGSTOP)
                    queue.extend((value,pid,fd) for value in children(pid,deadline))
                except ProcessLookupError: pass
            for fd in reversed(held):
                try: signal.pidfd_send_signal(fd,signal.SIGKILL)
                except ProcessLookupError: pass
        finally:
            for fd in held: os.close(fd)
        if child is not None and child.returncode is None:
            try: child.wait(timeout=.1)
            except subprocess.TimeoutExpired: pass
        while True:
            try:
                pid,_=os.waitpid(-1,os.WNOHANG)
                if pid==0: break
            except ChildProcessError: break
        time.sleep(.005)
    if child is not None and child.returncode is None: child.wait(timeout=.1)
try:
    if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'): raise RuntimeError('pidfds unavailable')
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.prctl(36,1,0,0,0)!=0: raise RuntimeError('subreaper unavailable')
    connection=socket.create_connection(('127.0.0.1',spec['port']),timeout=5)
    def report(value):
        value['token']=spec['token']; connection.sendall((json.dumps(value)+'\n').encode())
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(sig,stopped)
    child=subprocess.Popen(spec['command'],cwd=spec['cwd'],close_fds=True)
    report({'type':'started','pid':child.pid})
    incoming=b''
    while child.poll() is None and not stop:
        ready,_,_=select.select([connection],[],[],.02)
        if ready:
            chunk=connection.recv(1024)
            if not chunk: stop=True; break
            incoming+=chunk
            if len(incoming)>1024: raise RuntimeError('control budget')
            if b'\n' in incoming:
                message=json.loads(incoming.split(b'\n',1)[0])
                if message.get('token')!=spec['token'] or message.get('type')!='stop': raise RuntimeError('control identity')
                stop=True
    cleanup()
    report({'type':'exited','exitCode':child.returncode})
except BaseException:
    try: cleanup()
    except BaseException: pass
    sys.stderr.write('Linux process ownership cleanup was not confirmed\n')
    sys.exit(1)
finally:
    if connection is not None: connection.close()
`;

export async function linuxProcessJob(command: string[], cwd: string): Promise<WindowsProcessJob> {
  const token = randomUUID(); let ready!: (pid: number) => void, finished!: (code: number) => void, rejectReady!: (error: Error) => void, rejectFinished!: (error: Error) => void;
  const started = new Promise<number>((resolve, reject) => { ready = resolve; rejectReady = reject; }); const exited = new Promise<number>((resolve, reject) => { finished = resolve; rejectFinished = reject; }); void started.catch(() => {}); void exited.catch(() => {});
  let socket: Socket | undefined; let running = false, done = false; let input = Buffer.alloc(0); let startupTimer: NodeJS.Timeout;
  const failed = (): void => { if (done) return; done = true; clearTimeout(startupTimer); const error = new Error('Linux process cleanup proof was lost'); rejectReady(error); rejectFinished(error); socket?.destroy(); server.close(); };
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
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); server.on('error', failed); resolve(); }); }); const port = (server.address() as AddressInfo).port;
  startupTimer = setTimeout(failed, 10000); startupTimer.unref();
  return { command: ['/usr/bin/python3', '-I', '-B', '-c', controller], env: { HARNESS_LINUX_PROCESS_COMMAND: JSON.stringify({ command, cwd, port, token }) }, started, exited,
    signal: async () => { if (!socket || !running || done) { if (done) return; throw new Error('Linux process control is not ready'); } await new Promise<void>((resolve, reject) => socket!.write(JSON.stringify({ token, type: 'stop' }) + '\n', error => error && !done ? reject(error) : resolve())); },
    dispose: () => { if (!done) failed(); else { clearTimeout(startupTimer); socket?.destroy(); server.close(); } },
  };
}
