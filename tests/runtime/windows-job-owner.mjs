import { spawn } from 'node:child_process';
import { windowsJob } from '../../src/runtime/windows-job.ts';
let body = '';
process.stdin.setEncoding('utf8').on('data', chunk => { body += chunk; });
process.stdin.on('end', () => {
  const native = windowsJob(JSON.parse(body)).command;
  const controller = spawn(native.bin, native.args, { cwd: native.cwd, env: native.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  controller.stderr.on('data', () => {}); controller.stdin.on('error', () => {});
  controller.stdout.pipe(process.stdout);
  process.stdout.write(JSON.stringify({ controllerPid: controller.pid }) + '\n');
  controller.stdin.write(JSON.stringify({ id: 1, method: 'spawn' }) + '\n');
});
