import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

// Socket names have a small kernel byte limit even when the checkout's path is long.
// Only the socket lives here; runtime homes and evidence stay in the test workspace.
export function temporaryWorkerSocket() {
  const directory = mkdtempSync(path.join(realpathSync('/tmp'), 'ch-ipc-'));
  return { socketPath: path.join(directory, 'worker.sock'), close: () => rmSync(directory, { recursive: true, force: true }) };
}
