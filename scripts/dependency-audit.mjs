import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PatchProofError, readBoundedOrdinaryFile, verifyInstalledPicomatch } from './picomatch-patch-proof.mjs';

const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const approvedGhsa = 'GHSA-fc5q-39xc-vjpf';
export class AuditReportError extends Error {}

function validateAdvisory(key, advisory, seen) {
  if (!object(advisory)) throw new AuditReportError('Unknown advisory identity');
  const identity = typeof advisory.github_advisory_id === 'string' && /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(advisory.github_advisory_id);
  const packageName = typeof advisory.module_name === 'string' && /^[a-zA-Z0-9@/_.-]{1,214}$/.test(advisory.module_name);
  const findings = Array.isArray(advisory.findings) && advisory.findings.length > 0 && advisory.findings.length <= 4096;
  if (!identity || !packageName || !findings || !severities.includes(advisory.severity) || seen.has(advisory.github_advisory_id) || String(advisory.id) !== key) throw new AuditReportError('Unknown advisory identity');
  seen.add(advisory.github_advisory_id);
  for (const finding of advisory.findings) {
    if (!object(finding)) throw new AuditReportError('Unknown dependency finding');
    const version = typeof finding.version === 'string' && finding.version.length > 0 && finding.version.length <= 128;
    const paths = Array.isArray(finding.paths) && finding.paths.length > 0 && finding.paths.length <= 65536;
    if (!version || !paths || finding.paths.some(value => typeof value !== 'string' || !value.length || value.length > 4096)) throw new AuditReportError('Unknown dependency finding');
  }
}

/** The original registry result is retained. A local repair is a distinct classification, never a scanner pass. */
export function classifyDependencyAudit(report, auditExit, proof) {
  if (![0, 1].includes(auditExit) || !object(report)) throw new AuditReportError('Unknown dependency audit result');
  const fields = Object.keys(report).every(key => ['advisories', 'metadata'].includes(key));
  if (!fields || !object(report.advisories) || !object(report.metadata) || !object(report.metadata.vulnerabilities)) throw new AuditReportError('Unknown dependency audit result');
  const metadata = report.metadata.vulnerabilities;
  if (Object.keys(metadata).length !== severities.length || severities.some(level => !nonnegative(metadata[level]))) throw new AuditReportError('Unknown vulnerability counts');
  const entries = Object.entries(report.advisories);
  if (entries.length > 4096) throw new AuditReportError('Dependency advisory count exceeds budget');
  const classified = [], blocked = [], reported = { high: 0, critical: 0 };
  const seen = new Set();
  for (const [key, advisory] of entries) {
    validateAdvisory(key, advisory, seen);
    if (!['high', 'critical'].includes(advisory.severity)) continue;
    reported[advisory.severity]++;
    const identity = { ghsa: advisory.github_advisory_id, package: advisory.module_name, severity: advisory.severity };
    const approvedIdentity = advisory.github_advisory_id === approvedGhsa && advisory.module_name === 'picomatch' && advisory.severity === 'high';
    const approvedRange = typeof advisory.vulnerable_versions === 'string' && advisory.vulnerable_versions.replaceAll(' ', '') === '<=4.0.7';
    const approvedFindings = advisory.findings.every(finding => finding.version === '4.0.7' && finding.paths.every(value => value.split('>').at(-1) === 'picomatch'));
    const proven = proof?.package === 'picomatch' && proof.version === '4.0.7' && Array.isArray(proof.instances) && proof.instances.length && Array.isArray(proof.consumers) && proof.consumers.length;
    if (approvedIdentity && approvedRange && approvedFindings && proven) classified.push({ ...identity, classification: 'locally-remediated', version: '4.0.7', patchSha256: proof.patchSha256 });
    else blocked.push({ ...identity, classification: 'unresolved' });
  }
  // pnpm --audit-level high omits lower-severity records, but must enumerate
  // every high/critical advisory. An incomplete/error/changed response fails closed.
  if (metadata.high !== reported.high || metadata.critical !== reported.critical || auditExit !== (reported.high + reported.critical > 0 ? 1 : 0)) throw new AuditReportError('Audit exit or high-severity counts are inconsistent');
  return { schemaVersion: 1, status: blocked.length ? 'blocked' : 'passed', auditExit, originalCounts: metadata, locallyRemediated: classified, unresolved: blocked, note: 'Registry findings are unchanged in dependency-audit.json. Local remediation applies only to exact verified installed content; other high/critical findings block.' };
}

/** Always recompute the proof in this process; no caller-provided attestation file is trusted. */
export function checkDependencyAudit(base, auditExit) {
  const file = path.join(base, 'dependency-audit.json');
  let raw, report;
  try { raw = readBoundedOrdinaryFile(file, 16 * 1024 * 1024); }
  catch { throw new AuditReportError('dependency-audit.json is missing, unreadable, substituted or exceeds its size limit'); }
  try { report = JSON.parse(raw.toString('utf8')); }
  catch { throw new AuditReportError('dependency-audit.json is not complete JSON'); }
  const proof = verifyInstalledPicomatch(base);
  const result = classifyDependencyAudit(report, auditExit, proof);
  return { ...result, auditSha256: createHash('sha256').update(raw).digest('hex'), proof };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = fileURLToPath(new URL('..', import.meta.url));
  let result;
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--audit-exit' || !/^[01]$/.test(process.argv[3])) throw new AuditReportError('Explicit audit exit code required');
    result = checkDependencyAudit(base, Number(process.argv[3]));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    const known = error instanceof AuditReportError || error instanceof PatchProofError;
    result = { schemaVersion: 1, status: 'blocked', stage: error instanceof PatchProofError ? 'installed-patch-proof' : 'audit-report',
      reason: known ? error.message : 'Unexpected verification failure; the original audit is retained and the gate remains blocked.' };
    process.exitCode = 1;
  }
  try { writeFileSync(path.join(base, 'dependency-audit-classification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); }
  catch { console.error('Classification output already exists or cannot be created safely; no existing report was overwritten.'); process.exitCode = 1; }
  console.log(JSON.stringify({ status: result.status, locallyRemediated: result.locallyRemediated?.length ?? 0, unresolved: result.unresolved?.length ?? null }));
}
