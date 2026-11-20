import { linuxOwnership } from './linux-ownership.js';
import { DeliveryError, integer, object, type JsonObject } from './types.js';
import type { WindowsProcessJob } from './windows-process.js';

// The native protocol already creates a private pair of pipes per process
// handle. The controller exclusively owns them. Target children receive
// separate stdio (or a real PTY) and never inherit the control pipe ends.
const controller = String.raw`
import base64, ctypes, errno, fcntl, json, os, pathlib, pty, select, signal, struct, subprocess, sys, termios, time
spec=json.loads(os.environ.pop('HARNESS_LINUX_PROCESS_COMMAND'))
child=None
stop=False
def stopped(*_):
    global stop
    stop=True
${linuxOwnership}
def report(**value):
    data=(json.dumps(value,separators=(',',':'))+'\n').encode()
    while data: data=data[os.write(1,data):]
def resize(master,size):
    fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',size['rows'],size['cols'],0,0))
def owned_tty():
    os.setsid()
    fcntl.ioctl(0,termios.TIOCSCTTY,0)
def output(stream,data):
    cap=spec['cap']
    if stream in truncated: return
    capped=False
    if cap is not None:
        left=max(0,cap-emitted[stream]); capped=len(data)>left; data=data[:left]
        if capped: truncated.add(stream)
    emitted[stream]+=len(data)
    if data or capped: report(type='output',stream=stream,data=base64.b64encode(data).decode(),capReached=capped)
try:
    if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'): raise RuntimeError('pidfds unavailable')
    if ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)!=0: raise RuntimeError('subreaper unavailable')
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(sig,stopped)
    if spec['tty']:
        master,slave=pty.openpty()
        if spec.get('size'): resize(master,spec['size'])
        try: child=subprocess.Popen(spec['command'],cwd=spec['cwd'],stdin=slave,stdout=slave,stderr=slave,close_fds=True,preexec_fn=owned_tty)
        finally: os.close(slave)
        streams={master:'stdout'}; writer=master
    else:
        child=subprocess.Popen(spec['command'],cwd=spec['cwd'],stdin=subprocess.PIPE if spec['stdin'] else subprocess.DEVNULL,
                               stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True,start_new_session=True)
        streams={child.stdout.fileno():'stdout',child.stderr.fileno():'stderr'}
        writer=child.stdin.fileno() if child.stdin else None
    if writer is not None: os.set_blocking(writer,False)
    emitted={'stdout':0,'stderr':0}; truncated=set()
    report(type='started',pid=child.pid)
    incoming=b''; pending=bytearray(); closing=False; reaped=False; drain=None; drain_timeout=False
    while not stop:
        if child.poll() is not None and not reaped:
            cleanup(); reaped=True; drain=time.monotonic()+2
        if reaped and (not streams or time.monotonic()>drain):
            drain_timeout=bool(streams); break
        readable,writable,_=select.select([0,*streams], [writer] if writer is not None and pending else [], [], .03)
        if 0 in readable:
            data=os.read(0,65536)
            if not data: stop=True; break
            incoming+=data
            while b'\n' in incoming:
                line,incoming=incoming.split(b'\n',1)
                if len(line)>100000: raise ValueError('oversized control frame')
                msg=json.loads(line); kind=msg['type']; seq=msg['seq']
                if kind=='stop': stop=True; break
                if kind=='resize' and spec['tty']: resize(master,msg['size'])
                elif kind=='input':
                    content=base64.b64decode(msg.get('data',''),validate=True)
                    if writer is None or closing or len(pending)+len(content)>1048576:
                        report(type='ack',seq=seq,accepted=False); continue
                    pending.extend(content)
                    if msg.get('close'):
                        closing=True
                        if spec['tty']: pending.extend(b'\x04')
                else: raise ValueError('invalid control method')
                report(type='ack',seq=seq,accepted=True)
            if len(incoming)>100000: raise ValueError('oversized control frame')
        if stop: break
        if writer is not None and writer in writable:
            try: del pending[:os.write(writer,pending)]
            except BlockingIOError: pass
            except (BrokenPipeError,OSError): pending.clear(); closing=True
        if closing and not pending and writer is not None:
            if not spec['tty']: child.stdin.close()
            writer=None
        for fd in readable:
            if fd not in streams: continue
            try: data=os.read(fd,24576)
            except OSError as exc:
                if exc.errno!=errno.EIO: raise
                data=b''
            if data: output(streams[fd],data)
            else: del streams[fd]
    cleanup()
    report(type='exited',exitCode=child.returncode,drainTimeout=drain_timeout)
except BaseException:
    try: cleanup()
    except BaseException: pass
    sys.stderr.write('Linux process ownership cleanup was not confirmed\n')
    sys.exit(1)
`;

type Write = (bytes: string, beforeWrite?: () => void) => Promise<void>;
export interface LinuxProcessJob extends WindowsProcessJob {
  readonly transport: 'private-pipe';
  feed(bytes: Buffer): void;
  control(type: 'input' | 'resize', data: JsonObject, beforeWrite: () => void): Promise<void>;
  endNative(): void;
  drainTimedOut: boolean;
}
export function linuxProcessJob(command: string[], cwd: string, options: { tty: boolean; stdin: boolean; size?: JsonObject; cap: number | null },
  write: Write, output: (stream: 'stdout' | 'stderr', data: string, capReached: boolean) => void): LinuxProcessJob {
  let ready!: (pid: number) => void, finish!: (code: number) => void, rejectReady!: (error: Error) => void, rejectExit!: (error: Error) => void;
  const started = new Promise<number>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const exited = new Promise<number>((resolve, reject) => { finish = resolve; rejectExit = reject; });
  void started.catch(() => {}); void exited.catch(() => {});
  const pending = new Map<number, { ok(): void; fail(error: Error): void }>();
  let running = false, ended = false, next = 1, partial = Buffer.alloc(0);
  const failure = () => new Error('Linux process cleanup proof was lost');
  const terminate = () => {
    clearTimeout(watch); if (!ended) { ended = true; rejectReady(failure()); rejectExit(failure()); }
    for (const waiter of pending.values()) waiter.fail(failure());
    pending.clear(); partial = Buffer.alloc(0);
  };
  const watch = setTimeout(terminate, 12000); watch.unref();
  const send = (seq: number, type: string, body: JsonObject, beforeWrite?: () => void) =>
    write(Buffer.from(JSON.stringify({ ...body, seq, type }) + '\n').toString('base64'), beforeWrite);
  const job: LinuxProcessJob = {
    transport: 'private-pipe', command: ['/usr/bin/python3', '-I', '-u', '-c', controller],
    env: { HARNESS_LINUX_PROCESS_COMMAND: JSON.stringify({ command, cwd, ...options }) }, started, exited, drainTimedOut: false,
    feed(bytes) {
      if (ended) return;
      partial = Buffer.concat([partial, bytes]);
      for (;;) {
        const at = partial.indexOf(10); if (at < 0) break;
        if (at > 40000) throw failure();
        const msg = object(JSON.parse(partial.subarray(0, at).toString('utf8'))); partial = partial.subarray(at + 1);
        if (msg.type === 'started' && !running) {
          const pid = integer(msg.pid, 'controller child', 1, 2147483647); running = true; clearTimeout(watch); ready(pid);
        } else if (running && msg.type === 'output' && (msg.stream === 'stdout' || msg.stream === 'stderr') && typeof msg.data === 'string' && typeof msg.capReached === 'boolean') {
          output(msg.stream, msg.data, msg.capReached);
        } else if (running && msg.type === 'ack' && typeof msg.seq === 'number') {
          const waiter = pending.get(msg.seq); if (!waiter) throw failure();
          pending.delete(msg.seq); if (msg.accepted === true) waiter.ok(); else waiter.fail(new DeliveryError('process_input_busy', '进程输入已关闭或尚未读完，请稍后重试。'));
        } else if (running && msg.type === 'exited') {
          const code = integer(msg.exitCode, 'exit code', -2147483648, 2147483647);
          job.drainTimedOut = msg.drainTimeout === true; ended = true; finish(code); terminate();
        } else throw failure();
      }
      if (partial.length > 40000) throw failure();
    },
    async control(type, data, beforeWrite) {
      if (ended || !running) throw new DeliveryError('process_not_running', 'Process is not ready for input');
      if (pending.size >= 16) throw new DeliveryError('capacity', 'Too many pending process inputs');
      const seq = next++;
      let timer!: NodeJS.Timeout;
      const reply = new Promise<void>((resolve, reject) => { pending.set(seq, { ok: resolve, fail: reject }); timer = setTimeout(() => reject(failure()), 5000); timer.unref(); });
      void reply.catch(() => {});
      try { await send(seq, type, data, beforeWrite); await reply; }
      finally { clearTimeout(timer); pending.delete(seq); }
    },
    async signal() { if (!ended) await send(0, 'stop', {}); },
    endNative: terminate, dispose: terminate,
  };
  return job;
}
