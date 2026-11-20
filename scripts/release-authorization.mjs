import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { snapshot, evidencePath } from './snapshot.mjs';
import { validateRelative } from './release-audit.mjs';
import { ordinaryFile, validateAuditProofs } from './audit-rounds.mjs';

/** Establish the exact-source release authority; keep previously granted exceptions readable. */
export function releaseAuthorization(base, name, expectedHash, { allowHistorical = false } = {}) {
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
  const audited = record.kind === 'audited-release-closeout';
  const waiver = record.kind === 'explicit-user-release-closeout';
  if (record.schemaVersion !== 1 || (!audited && !waiver) || record.auditRoundsWaived !== waiver ||
      !/^[a-f0-9]{64}$/.test(record.sourceDigest) || !Number.isSafeInteger(record.sourceFiles) || record.sourceFiles < 1 ||
      (!allowHistorical && (record.sourceDigest !== current.digest || record.sourceFiles !== current.files)) ||
      !/^[a-f0-9]{40}$/.test(record.baseCommit ?? '') || /^0+$/.test(record.baseCommit) || !Number.isFinite(approvedAt) || approvedAt > Date.now())
    throw Error('Authorization does not match this source and review boundary');
  if (typeof record.userInstruction !== 'string' || record.userInstruction.trim().length < 20 ||
      record.repairsReviewed !== true || !Array.isArray(record.unresolvedBlockers) || record.unresolvedBlockers.length ||
      !Array.isArray(record.scopes) || !record.scopes.includes('full-tests')) throw Error('Explicit user instruction and completed repair review are required');
  if (waiver && (typeof record.auditWaiverInstruction !== 'string' || record.auditWaiverInstruction.trim().length < 20))
    throw Error('Explicit user instruction for an audit waiver is required');
  let audit;
  if (audited) {
    if (!/^[a-f0-9]{64}$/.test(record.auditRecordSha256)) throw Error('Exact audit record checksum is required');
    // Historical metadata describes a previous release and can never authorize a
    // run. The caller revalidates all current proofs before granting authority.
    if (!allowHistorical) {
      const name = 'verification/audits.json';
      const file = ordinaryFile(base, name);
      if (lstatSync(file).size > 16 * 1024 * 1024) throw Error('Audit record exceeds its size limit');
      const bytes = readFileSync(file);
      if (createHash('sha256').update(bytes).digest('hex') !== record.auditRecordSha256) throw Error('Audit record checksum changed');
      audit = validateAuditProofs(JSON.parse(bytes), current, base);
      if (Date.parse(audit.completedAt) > approvedAt) throw Error('Release authorization predates the completed audit rounds');
      audit.bindings.unshift({ path: name, sha256: record.auditRecordSha256 });
    }
  }
  const version = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8')).version;
  if (typeof record.version !== 'string' || (!allowHistorical && record.version !== version)) throw Error('Authorization version mismatch');
  return { path: name, sha256: expectedHash, sourceDigest: record.sourceDigest, sourceFiles: record.sourceFiles, baseCommit: record.baseCommit, version: record.version, ...(audit ? { audit } : {}) };
}
