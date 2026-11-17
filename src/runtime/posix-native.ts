import { linuxOwnership } from './linux-ownership.js';
import type { LaunchConfig } from './native-launch.js';

/** The native process inherits only stdio. The controller owns cleanup until its zero-exit proof. */
const controller = String.raw`
import ctypes, json, os, pathlib, select, signal, subprocess, sys, time
spec=json.loads(os.environ.pop('HARNESS_POSIX_NATIVE_COMMAND'))
child=None
stop=False
queue=None
exited_observed=False
def stopped(*_):
    global stop
    stop=True
${linuxOwnership}
def observed_exit():
    global exited_observed
    if exited_observed: return True
    # Neither path reaps the leader: its identity continues to reserve the PGID.
    if hasattr(os,'waitid') and hasattr(os,'WNOWAIT'):
        exited_observed=os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is not None
    else: exited_observed=bool(queue.control(None,1,0))
    return exited_observed
def group_live(deadline):
    # BSD/macOS do not offer Linux pidfds/subreaping. Inspect bounded ps output
    # while the unreaped child still reserves the group, ignoring dead zombies.
    probe=subprocess.Popen(['/bin/ps','-axo','pid=,pgid=,stat='],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,close_fds=True)
    data=b''
    try:
        while True:
            if time.monotonic()>deadline: raise RuntimeError('group inspection deadline')
            if not select.select([probe.stdout],[],[],.02)[0]: continue
            part=os.read(probe.stdout.fileno(),8192)
            if not part: break
            data+=part
            if len(data)>1024*1024: raise RuntimeError('group inspection budget')
        if probe.wait(timeout=.5)!=0: raise RuntimeError('group inspection failed')
    finally:
        # The probe has not been reaped on failure; this PID still belongs to it.
        if probe.returncode is None:
            probe.kill(); probe.wait(timeout=.5)
        probe.stdout.close()
    for line in data.decode('ascii').splitlines():
        parts=line.split()
        if len(parts)!=3: raise RuntimeError('group inspection invalid')
        if int(parts[1])==child.pid and int(parts[0])!=child.pid and not parts[2].startswith('Z'): return True
    return False
def portable_cleanup():
    if child is None: return
    if child.returncode is not None: raise RuntimeError('group leader already reaped')
    # There is no check-then-signal of a historical PID. Even natural exit keeps
    # the leader unreaped until every live group member has disappeared.
    try: os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    deadline=time.monotonic()+4
    while not observed_exit() or group_live(deadline):
        if time.monotonic()>deadline: raise RuntimeError('group cleanup deadline')
        time.sleep(.01)
    child.wait(timeout=.5)
try:
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(sig,stopped)
    if sys.platform=='linux':
        if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'): raise RuntimeError('pidfds unavailable')
        libc=ctypes.CDLL(None,use_errno=True)
        if libc.prctl(36,1,0,0,0)!=0: raise RuntimeError('subreaper unavailable')
    elif not hasattr(os,'waitid') or not hasattr(os,'WNOWAIT'):
        # macOS has kqueue process-exit observation rather than waitid(WNOWAIT).
        if not hasattr(select,'kqueue'): raise RuntimeError('non-reaping exit observation unavailable')
        queue=select.kqueue()
    child=subprocess.Popen(spec['command'],cwd=spec['cwd'],close_fds=True,start_new_session=True)
    if queue is not None:
        queue.control([select.kevent(child.pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ENABLE,fflags=select.KQ_NOTE_EXIT)],0,0)
    while not stop and os.getppid()==spec['owner']:
        # Descriptor 3 belongs only to this controller (close_fds excludes it
        # from native children). EOF works even before controller startup or
        # while the native protocol stdin is backpressured.
        if select.select([3],[],[],0)[0]:
            if os.read(3,1024)==b'': break
            raise RuntimeError('unexpected control input')
        if sys.platform=='linux':
            if child.poll() is not None: break
        elif observed_exit(): break
        time.sleep(.02)
    # Preserve a bounded native shutdown opportunity before force cleanup. The
    # main child is still owned here; Linux signals its pidfd, portable hosts
    # retain the unreaped group leader throughout this grace period.
    deadline=time.monotonic()+1
    if sys.platform=='linux':
        if child.returncode is None:
            descriptor=os.pidfd_open(child.pid,0)
            try:
                try: signal.pidfd_send_signal(descriptor,signal.SIGTERM)
                except ProcessLookupError: pass
            finally: os.close(descriptor)
            while child.poll() is None and time.monotonic()<deadline: time.sleep(.01)
        cleanup()
    else:
        if not observed_exit():
            try: os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            while not observed_exit() and time.monotonic()<deadline: time.sleep(.01)
        portable_cleanup()
except BaseException:
    try:
        if sys.platform=='linux': cleanup()
        else: portable_cleanup()
    except BaseException: pass
    sys.stderr.write('POSIX native process cleanup was not confirmed\n')
    sys.exit(1)
finally:
    if queue is not None: queue.close()
`;

export function posixNative(command: Required<Pick<LaunchConfig, 'bin' | 'args' | 'env' | 'cwd'>>): typeof command {
  return { bin: '/usr/bin/python3', args: ['-I', '-B', '-c', controller], cwd: command.cwd,
    env: { ...command.env, HARNESS_POSIX_NATIVE_COMMAND: JSON.stringify({ command: [command.bin, ...command.args], cwd: command.cwd, owner: process.pid }) } };
}
