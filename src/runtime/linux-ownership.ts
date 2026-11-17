/** Shared bounded pidfd/subreaper cleanup. No signal targets a historical PID. */
export const linuxOwnership = String.raw`
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
`;
