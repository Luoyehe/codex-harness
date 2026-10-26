import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { snapshot, evidencePath } from './snapshot.mjs';
import { validateRelative } from './release-audit.mjs';

/** An explicit, source-bound user exception; it never invents clean audit rounds. */
export function releaseAuthorization(base, name, expectedHash) {
  validateRelative(name);
  if (!/^verification\/audit-evidence\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json$/.test(name) || !evidencePath(name)) throw Error('Authorization must be a declared evidence file');
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw Error('Exact authorization checksum is required');
  let file = base;
  for (const part of name.split('/')) {
    file = path.join(file, part);
    if (lstatSync(file).isSymbolicLink()) throw Error('Authorization cannot traverse symlinks');
  }
  const bytes = readFileSync(file);
  if (bytes.length > 65536 || createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw Error('Authorization checksum mismatch');
  const record = JSON.parse(bytes.toString('utf8'));
  const current = snapshot(base);
  const approvedAt = Date.parse(record.approvedAt);
  if (record.schemaVersion !== 1 || record.kind !== 'explicit-user-release-closeout' || record.auditRoundsWaived !== true || record.sourceDigest !== current.digest || record.sourceFiles !== current.files || !/^[a-f0-9]{40}$/.test(record.baseCommit ?? '') || /^0+$/.test(record.baseCommit) || !Number.isFinite(approvedAt) || approvedAt > Date.now()) throw Error('Authorization does not match this source and review boundary');
  if (typeof record.userInstruction !== 'string' || record.userInstruction.trim().length < 20 || typeof record.auditWaiverInstruction !== 'string' || record.auditWaiverInstruction.trim().length < 20 || record.repairsReviewed !== true || !Array.isArray(record.unresolvedBlockers) || record.unresolvedBlockers.length || !Array.isArray(record.scopes) || !record.scopes.includes('full-tests')) throw Error('Explicit user instruction and completed repair review are required');
  const version = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8')).version;
  if (record.version !== version) throw Error('Authorization version mismatch');
  return { path: name, sha256: expectedHash, sourceDigest: current.digest, sourceFiles: current.files, baseCommit: record.baseCommit, version };
}
