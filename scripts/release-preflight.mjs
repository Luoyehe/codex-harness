import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCiPlan } from './ci-checks.mjs';
import { releaseAuthorization } from './release-authorization.mjs';
import { evidencePath, root, snapshot } from './snapshot.mjs';

const authorizationPath = 'verification/audit-evidence/release-closeout/authorization.json';
const buildRecord = '.work/release-preflight-build.json';
const reportPath = '.work/release-preflight.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const git = (base, args, input) => execFileSync('git', args, { cwd: base, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);

function workDirectory(base) {
  const directory = path.join(base, '.work');
  if (!existsSync(directory)) mkdirSync(directory);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) throw Error('Unsafe preflight evidence directory');
  return directory;
}

/** Hash actual bytes without clean filters or Git's stat cache; evidence remains a separate boundary. */
export function committedSource(base, head) {
  if (!commit(head) || git(base, ['rev-parse', 'HEAD']).trim() !== head) throw Error('Expected head must equal the checked-out commit');
  const current = snapshot(base, true);
  const entries = git(base, ['ls-tree', '-rz', '--full-tree', head]).split('\0').filter(Boolean).map(value => {
    const tab = value.indexOf('\t'), [mode, type, oid] = value.slice(0, tab).split(' '), name = value.slice(tab + 1);
    return { mode, type, oid, name };
  }).filter(entry => !evidencePath(entry.name));
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const names = entries.map(entry => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(current.names)) throw Error('Source inventory differs from the expected commit');
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const hashes = git(base, ['hash-object', '--no-filters', '--stdin-paths'], current.names.map(name => JSON.stringify(name)).join('\n') + '\n').trim().split('\n');
  if (hashes.length !== current.names.length) throw Error('Incomplete committed-source hash check');
  current.names.forEach((name, index) => {
    const entry = byName.get(name), bits = lstatSync(path.join(base, name)).mode & 0o111;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || entry.oid !== hashes[index] || bits !== (entry.mode === '100755' ? 0o111 : 0))
      throw Error(`Source bytes or executable bits differ from commit: ${name}`);
  });
  return current;
}

export function toolPins(base, nodeVersion = process.versions.node) {
  const common = readFileSync(path.join(base, 'deploy/common.py'), 'utf8'), pkg = json(path.join(base, 'package.json'));
  const pin = name => common.match(new RegExp(`^${name} = "([0-9]+\\.[0-9]+\\.[0-9]+)"$`, 'm'))?.[1];
  const node = pin('NODE_VERSION'), pnpm = pin('PNPM_VERSION'), codex = pin('CODEX_VERSION');
  if (!node || !pnpm || !codex || nodeVersion !== node || pkg.packageManager !== `pnpm@${pnpm}` || pkg.codexVersion !== codex) throw Error('Local Node/package/deployment tool pins disagree');
  const workflows = {};
  for (const name of ['affected', 'security', 'compatibility']) {
    const text = readFileSync(path.join(base, `.github/workflows/${name}.yml`), 'utf8');
    const versions = [...text.matchAll(/^\s*node-version:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map(match => match[1]);
    if (!versions.length || versions.some(value => value !== node)) throw Error(`Workflow Node pin disagrees: ${name}`);
    const managers = [...text.matchAll(/pnpm@([0-9]+\.[0-9]+\.[0-9]+)/g)].map(match => match[1]);
    if (managers.some(value => value !== pnpm)) throw Error(`Workflow pnpm pin disagrees: ${name}`);
    workflows[name] = { node: versions, pnpm: managers };
  }
  const affected = readFileSync(path.join(base, '.github/workflows/affected.yml'), 'utf8');
  if (!/^on:\r?\n  push:\r?\n    branches: \[main\]\r?\n  pull_request:\r?\n  workflow_dispatch:/m.test(affected)) throw Error('Reviewed workflow triggers differ from the declared main/PR/manual policy');
  const native = [...affected.matchAll(/^\s*package:\s*([0-9]+\.[0-9]+\.[0-9]+)-(linux|win32)-x64\s*$/gm)];
  if (native.length !== 2 || native.some(match => match[1] !== codex) || new Set(native.map(match => match[2])).size !== 2) throw Error('CI official CLI package pins disagree');
  const python = [...affected.matchAll(/^\s*python-version:\s*['"]?([0-9]+\.[0-9]+\.[0-9]+)['"]?\s*$/gm)].map(match => match[1]);
  if (python.length !== 1) throw Error('CI Python must have one exact version pin');
  return { node, pnpm, codex, python: python[0], workflows };
}

function artifactInventory(base) {
  const rows = [];
  for (const name of ['dist', 'web/dist']) {
    const directory = path.resolve(base, name);
    // Fixed generated directories only; never follow a substituted parent or output symlink.
    if (!directory.startsWith(realpathSync(base) + path.sep) || realpathSync(path.dirname(directory)) !== path.dirname(directory)) throw Error('Unsafe build output parent');
    const visit = (folder, relative) => {
      const info = lstatSync(folder); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Build output must be a regular directory');
      for (const item of readdirSync(folder).sort()) {
        const file = path.join(folder, item), child = lstatSync(file), key = `${relative}/${item}`;
        if (child.isDirectory() && !child.isSymbolicLink()) visit(file, key);
        else if (child.isFile() && !child.isSymbolicLink()) rows.push({ path: key, bytes: child.size, executableBits: child.mode & 0o111, sha256: sha(readFileSync(file)) });
        else throw Error('Build outputs cannot contain symlinks or special files');
      }
    };
    visit(directory, name);
  }
  for (const required of ['dist/src/gateway/main.js', 'dist/src/runtime/main.js', 'web/dist/index.html'])
    if (!rows.some(row => row.path === required && row.bytes > 0)) throw Error(`Required build output missing: ${required}`);
  return rows;
}

function buildTools(base) {
  const pkg = json(path.join(base, 'package.json')), versions = {};
  for (const name of ['typescript', 'vite']) {
    const version = json(path.join(base, 'node_modules', name, 'package.json')).version;
    if (version !== pkg.devDependencies?.[name]) throw Error(`Installed build tool differs from package pin: ${name}`);
    versions[name] = version;
  }
  return versions;
}

export function checkBuild(base, source, pins, head, rebuild = false) {
  workDirectory(base);
  const tools = buildTools(base), file = path.join(base, buildRecord);
  if (rebuild) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file)) rmSync(file);
    for (const name of ['dist', 'web/dist']) {
      const target = path.resolve(base, name);
      if (!target.startsWith(realpathSync(base) + path.sep) || realpathSync(path.dirname(target)) !== path.dirname(target)) throw Error('Unsafe build output parent');
      if (existsSync(target)) {
        const info = lstatSync(target); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Refusing to replace unsafe build output');
        rmSync(target, { recursive: true });
      }
    }
    for (const args of [
      ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'web/tsconfig.json'],
      ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json'],
      ['node_modules/vite/bin/vite.js', 'build', '--config', 'web/vite.config.ts'],
    ]) execFileSync(process.execPath, args, { cwd: base, stdio: 'inherit', windowsHide: true });
    const after = committedSource(base, head);
    if (after.digest !== source.digest) throw Error('Source changed during build');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: 'source-bound-build', sourceDigest: source.digest, sourceFiles: source.files, builtForHead: head, node: pins.node, tools, createdAt: new Date().toISOString(), outputs: artifactInventory(base) }, null, 2) + '\n');
  }
  if (!existsSync(file)) throw Error('Source-bound build evidence is missing; use --build after installing frozen dependencies');
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw Error('Invalid build evidence file');
  const record = json(file);
  if (record.schemaVersion !== 1 || record.kind !== 'source-bound-build' || record.sourceDigest !== source.digest || record.sourceFiles !== source.files || record.node !== pins.node || JSON.stringify(record.tools) !== JSON.stringify(tools) || JSON.stringify(record.outputs) !== JSON.stringify(artifactInventory(base)))
    throw Error('Build evidence is stale or outputs changed; use --build');
  return { path: buildRecord, sha256: sha(readFileSync(file)), builtForHead: record.builtForHead, sourceDigest: record.sourceDigest, outputs: record.outputs.length, rebuilt: rebuild };
}

export function releasePreflight(options, base = root) {
  base = realpathSync(base);
  const { head, pushBase, prBase, authorizationSha256, build = false } = options;
  if (![head, pushBase, prBase].every(commit)) throw Error('Exact nonzero --head, --push-base and --pr-base commits are required');
  const source = committedSource(base, head);
  const authorization = releaseAuthorization(base, authorizationPath, authorizationSha256);
  if (sha(Buffer.from(git(base, ['show', `${head}:${authorizationPath}`]), 'utf8')) !== authorization.sha256) throw Error('Authorization must match the expected committed bytes');
  const pins = toolPins(base);
  const env = { HARNESS_CI_HEAD: head, HARNESS_AUTHORIZATION_SHA: authorizationSha256 };
  const push = buildCiPlan(base, { ...env, HARNESS_CI_BASE: pushBase });
  const pullRequest = buildCiPlan(base, env, { pull_request: { head: { sha: head }, base: { sha: prBase } } });
  if (pullRequest.mode !== 'authorized-full') throw Error('Release pull request does not select the authorized full inventory');
  const artifacts = checkBuild(base, source, pins, head, build);
  if (committedSource(base, head).digest !== source.digest) throw Error('Source changed during preflight');
  releaseAuthorization(base, authorizationPath, authorizationSha256);
  return { schemaVersion: 1, status: 'ready-for-ci', preflightPassed: true, releaseGatePassed: false, testsExecuted: false,
    note: 'Commit, source, authorization, plans, pins and build evidence checked. This is not test success or release approval.',
    head, sourceDigest: source.digest, sourceFiles: source.files, authorization, pins, build: artifacts,
    plans: { push, pullRequest }, triggers: { pushBranches: ['main'], pullRequest: true, workflowDispatch: true,
      topicWithoutPullRequest: 'Run local targeted tests or explicit workflow_dispatch; no automatic topic-push run.' }, checkedAt: new Date().toISOString() };
}

export function parsePreflightArgs(args) {
  const names = { '--head': 'head', '--push-base': 'pushBase', '--pr-base': 'prBase', '--authorization-sha256': 'authorizationSha256' }, options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], key = flag === '--build' ? 'build' : names[flag];
    if (!key || Object.hasOwn(options, key)) throw Error('Unknown or repeated preflight argument');
    if (flag === '--build') options.build = true;
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw Error(`Value required for ${flag}`); options[key] = value; }
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report;
  try { report = releasePreflight(parsePreflightArgs(process.argv.slice(2))); }
  catch (error) { report = { schemaVersion: 1, status: 'blocked', preflightPassed: false, releaseGatePassed: false, testsExecuted: false, reason: error.message }; process.exitCode = 1; }
  workDirectory(root); writeFileSync(path.join(root, reportPath), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, testsExecuted: false, head: report.head, sourceDigest: report.sourceDigest,
    plans: report.plans && Object.fromEntries(Object.entries(report.plans).map(([name, plan]) => [name, { mode: plan.mode, base: plan.baseCommit, files: plan.files.length, targets: plan.targets }])), reason: report.reason, report: reportPath }));
}
