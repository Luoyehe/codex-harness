import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { Authentication } from './auth.js';
import { Dispatcher } from './dispatch.js';
import { WorkerClient } from './worker-client.js';
import { ManagerClient } from './manager-client.js';
import { GatewayServer } from './server.js';
import { Ledger } from '../core/ledger.js';
import type { HarnessEvent } from '../core/contracts.js';
import { AutomationScheduler } from './automation-scheduler.js';

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
async function main(): Promise<void> {
  const dev = process.env.HARNESS_DEV === '1';
  if (!dev && (process.platform !== 'linux' || process.getuid?.() === 0)) throw new Error('Installed gateway must run as its dedicated non-root Linux identity');
  const tokenFile = required('HARNESS_TOKEN_FILE'); const tokenInfo = lstatSync(tokenFile);
  if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || tokenInfo.size > 4096 || (!dev && (tokenInfo.mode & 0o007) !== 0)) throw new Error('Invalid gateway token file');
  const token = readFileSync(tokenFile, 'utf8').trim();
  const state = required('HARNESS_STATE_DIR');
  const auth = new Authentication({ database: path.join(state, 'auth.sqlite'), bootstrapToken: token,
    bootstrapFile: process.env.HARNESS_AUTH_BOOTSTRAP_FILE ?? path.join(path.dirname(tokenFile), 'auth-bootstrap.json'), strictFiles: !dev }, required('HARNESS_ORIGIN'));
  const worker = new WorkerClient(dev ? { port: Number(process.env.HARNESS_WORKER_PORT ?? 4318), token: required('HARNESS_WORKER_TOKEN') } : { socketPath: required('HARNESS_WORKER_SOCKET') });
  const ledger = new Ledger(path.join(state, 'journal.sqlite')); ledger.recover();
  const dispatcher = new Dispatcher(ledger, worker, new ManagerClient(process.env.HARNESS_MANAGE_COMMAND));
  const scheduler = new AutomationScheduler(ledger, dispatcher, worker);
  worker.on('event', (event: HarnessEvent) => dispatcher.event(event)); worker.on('disconnect', () => dispatcher.disconnected());
  const server = new GatewayServer(auth, dispatcher, worker, process.env.HARNESS_STATIC_DIR);
  const port = Number(process.env.HARNESS_LISTEN_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listen port');
  worker.connect(); await server.listen(port); scheduler.start();
  process.stdout.write(`Codex Harness gateway listening on 127.0.0.1:${port}\n`);
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    const timer = setTimeout(() => process.exit(1), 15000); timer.unref();
    const finished = (code: number) => { worker.close(); ledger.close(); auth.close(); clearTimeout(timer); process.exit(code); };
    void Promise.all([server.close(), scheduler.close()]).then(() => finished(0), () => finished(1));
  };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
main().catch(() => { process.stderr.write('Gateway startup failed; check installed configuration and file permissions.\n'); process.exit(1); });
