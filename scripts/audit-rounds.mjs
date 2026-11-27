import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { snapshot, root, evidencePath } from './snapshot.mjs';
import { validateRelative } from './release-audit.mjs';
import { validateFreshnessEvidence } from './check-builtin-mcp.mjs';

const requiredScopes = ['gateway-core', 'runtime-protocol', 'web-ux', 'deployment-release'];
const scopeAreas = {
  'gateway-core': [/^src\/core\//, /^src\/gateway\//],
  'runtime-protocol': [/^src\/runtime\//, /^protocol\//],
  'web-ux': [/^web\//],
  'deployment-release': [/^deploy\//, /^(?:scripts|\.github)\//],
};
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const clean = value => Array.isArray(value) && value.length === 0;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

export function ordinaryFile(base, name) {
  validateRelative(name); let current = base; const parts = name.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]); const info = lstatSync(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new Error('Test/evidence path is not an ordinary repository file');
  }
  return current;
}

function readEvidence(base, name, expectedHash) {
  if (typeof name !== 'string' || !/^verification\/audit-evidence\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.json$/.test(name) ||
      !/^[a-f0-9]{64}$/.test(expectedHash)) throw Error('Invalid audit evidence reference');
  const file = ordinaryFile(base, name);
  if (lstatSync(file).size > 16 * 1024 * 1024) throw Error('Audit evidence exceeds its size limit');
  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw Error('Audit evidence checksum changed');
  return JSON.parse(bytes);
}

export function validateAuditProofs(record, current, base = root) {
  if (record?.schemaVersion !== 1 || !Array.isArray(record.rounds) || record.rounds.length < 2) throw new Error('Two recorded audit rounds are required');
  const inventory = snapshot(base, true);
  if (inventory.digest !== current.digest) throw new Error('Source changed while validating audit coverage');
  const expected = new Set(inventory.names);
  const rounds = record.rounds.slice(-2); const ids = new Set(); const reviewers = new Set(); const evidenceFiles = new Set(); let previous;
  const bindings = [];
  for (const round of rounds) {
    if (!identity(round.id) || ids.has(round.id) || !Number.isSafeInteger(round.sequence) || round.sequence < 1 || round.digest !== current.digest || round.complete !== true || !clean(round.findings) || !clean(round.skipped) || !Array.isArray(round.scopes) || !requiredScopes.every(scope => round.scopes.includes(scope))) throw new Error('Each audit must be complete, clean, scoped and bound to the current source');
    if (!timestamp(round.startedAt) || !timestamp(round.completedAt) || Date.parse(round.startedAt) >= Date.parse(round.completedAt) || Date.parse(round.completedAt) > Date.now()) throw new Error('Audit timing evidence is invalid');
    if (previous && (round.sequence !== previous.sequence + 1 || Date.parse(round.startedAt) < Date.parse(previous.completedAt))) throw new Error('Audit rounds must be consecutive and independently completed');
    if (!Array.isArray(round.reviewers) || !round.reviewers.length) throw new Error('Independent reviewer evidence is required');
    const proof = round.builtinMcpFreshness;
    if (!proof || evidenceFiles.has(proof.path)) throw Error('A distinct builtin MCP check is required for each audit round');
    const freshness = readEvidence(base, proof.path, proof.sha256);
    validateFreshnessEvidence(freshness, current, round, base);
    evidenceFiles.add(proof.path); bindings.push({ path: proof.path, sha256: proof.sha256 });
    const reviewed = new Set(); const inspected = new Set();
    for (const reviewer of round.reviewers) {
      if (!identity(reviewer.id) || reviewers.has(reviewer.id) || !Array.isArray(reviewer.scopes) || !reviewer.scopes.length || reviewer.scopes.some(scope => !requiredScopes.includes(scope))) throw new Error('Reviewer identities must be distinct and scopes explicit');
      if (typeof reviewer.evidence !== 'string' || !/^verification\/audit-evidence\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.json$/.test(reviewer.evidence) || !evidencePath(reviewer.evidence) || evidenceFiles.has(reviewer.evidence) || !/^[a-f0-9]{64}$/.test(reviewer.sha256)) throw new Error('Reviewer evidence requires a unique local JSON artifact and checksum');
      const evidence = readEvidence(base, reviewer.evidence, reviewer.sha256);
      bindings.push({ path: reviewer.evidence, sha256: reviewer.sha256 });
      if (evidence.schemaVersion !== 1 || evidence.roundId !== round.id || evidence.reviewerId !== reviewer.id || evidence.digest !== current.digest || evidence.complete !== true || !clean(evidence.findings) || !clean(evidence.skipped) || !Array.isArray(evidence.scopes) || reviewer.scopes.some(scope => !evidence.scopes.includes(scope)) || typeof evidence.method !== 'string' || evidence.method.trim().length < 20 || !Array.isArray(evidence.inspectedFiles) || !evidence.inspectedFiles.length) throw new Error('Reviewer artifact does not establish the declared clean audit');
      for (const name of evidence.inspectedFiles) { if (!expected.has(validateRelative(name))) throw new Error('Audit coverage must inspect current source, not its own evidence'); ordinaryFile(base, name); inspected.add(name); }
      for (const scope of reviewer.scopes) if (!scopeAreas[scope].every(area => evidence.inspectedFiles.some(name => area.test(name)))) throw new Error('Reviewer artifact is missing source evidence for its claimed scope coverage');
      reviewer.scopes.forEach(scope => reviewed.add(scope)); reviewers.add(reviewer.id); evidenceFiles.add(reviewer.evidence);
    }
    if (!requiredScopes.every(scope => reviewed.has(scope))) throw new Error('Reviewer evidence does not cover every required scope');
    if ([...expected].some(name => !inspected.has(name))) throw new Error('Complete audits must inspect the entire source inventory, including tests, configuration and documentation');
    ids.add(round.id); previous = round;
  }
  return { rounds: rounds.map(round => round.id), completedAt: rounds.at(-1).completedAt, bindings };
}

export function validateAuditRecord(record, current, base = root) {
  return validateAuditProofs(record, current, base).rounds;
}
