import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function requireSuccessfulJobs(needs) {
  if (needs?.plan?.result !== 'success') throw Error('Test planning did not succeed');
  for (const [job, output] of [['standard', 'standard'], ['root_deploy', 'root']]) {
    const requested = needs.plan.outputs?.[output];
    if (!['true', 'false'].includes(requested)) throw Error('Missing test plan job selection');
    if (needs[job]?.result !== (requested === 'true' ? 'success' : 'skipped')) throw Error(`Required job outcome mismatch: ${job}`);
  }
  return true;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { requireSuccessfulJobs(JSON.parse(process.env.HARNESS_CI_NEEDS ?? 'null')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
