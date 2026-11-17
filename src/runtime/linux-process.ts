import { linuxOwnership } from './linux-ownership.js';
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
${linuxOwnership}
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
  let socket: Socket | undefined; let running = false, done = false; let startupTimer: NodeJS.Timeout;
  const candidates = new Set<Socket>();
  const failed = (): void => { if (done) return; done = true; clearTimeout(startupTimer); const error = new Error('Linux process cleanup proof was lost'); rejectReady(error); rejectFinished(error); socket?.destroy(); for (const candidate of candidates) candidate.destroy(); server.close(); };
  const server = createServer(incoming => {
    if (socket || done || candidates.size >= 8) { incoming.destroy(); return; }
    candidates.add(incoming); let input = Buffer.alloc(0);
    incoming.setTimeout(500, () => { if (socket !== incoming) incoming.destroy(); });
    const rejected = (): void => { if (socket === incoming) failed(); else incoming.destroy(); };
    incoming.on('error', rejected); incoming.on('close', () => { candidates.delete(incoming); if (socket === incoming && !done) failed(); });
    incoming.on('data', bytes => {
      if (input.length + bytes.length > 2048) { rejected(); return; } input = Buffer.concat([input, bytes]);
      for (;;) { const index = input.indexOf(10); if (index < 0) break; const line = input.subarray(0, index).toString('utf8'); input = input.subarray(index + 1);
        try { const message = JSON.parse(line) as { token?: unknown; type?: unknown; pid?: unknown; exitCode?: unknown }; if (message.token !== token) throw new Error();
          if (message.type === 'started' && !running && !socket && typeof message.pid === 'number' && Number.isSafeInteger(message.pid) && message.pid > 0) { socket = incoming; incoming.setTimeout(0); candidates.delete(incoming); for (const candidate of candidates) candidate.destroy(); candidates.clear(); server.close(); running = true; clearTimeout(startupTimer); ready(message.pid); }
          else if (message.type === 'exited' && running && typeof message.exitCode === 'number' && Number.isInteger(message.exitCode) && message.exitCode >= -2147483648 && message.exitCode <= 2147483647) { done = true; clearTimeout(startupTimer); finished(message.exitCode); incoming.end(); }
          else throw new Error();
        } catch { rejected(); return; }
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
