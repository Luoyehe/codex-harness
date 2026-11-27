import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.env.HARNESS_FIXTURE_SHUTDOWN_MARKER) process.on('SIGTERM', () => setTimeout(() => { writeFileSync(process.env.HARNESS_FIXTURE_SHUTDOWN_MARKER, 'native shutdown completed'); process.exit(0); }, 50));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'spawn' || request.method === 'spawn-exit' || request.method === 'spawn-group') {
    // Detached and inheriting the protocol output: root-exit/EOF-based cleanup
    // cannot reliably find or wait out this descendant.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: request.method !== 'spawn-group', stdio: ['ignore', 'inherit', 'inherit'] });
    child.unref();
    send({ id: request.id, result: { rootPid: process.pid, childPid: child.pid, args: process.argv.slice(2) } });
    if (request.method === 'spawn-exit') setTimeout(() => process.exit(7), 10);
  }
  if (request.method === 'pause') {
    process.stdin.pause(); lines.pause();
    process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));
  }
  if (request.method === 'exit') { send({ id: request.id, result: {} }); setTimeout(() => process.exit(7), 10); }
});
