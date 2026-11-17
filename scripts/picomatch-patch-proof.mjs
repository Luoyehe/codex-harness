import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, selected) => selected.startsWith(root + path.sep);
const stable = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
const relative = name => typeof name === 'string' && name.length <= 256 && !name.includes('\\') && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..') && !/[\x00-\x1f\x7f:]/.test(name);
export class PatchProofError extends Error {}

/** Read ordinary bounded files; never execute package or candidate code. */
function bytes(file, maximum = 2 * 1024 * 1024) {
  const selected = lstatSync(file);
  if (!selected.isFile() || selected.isSymbolicLink() || selected.size > maximum) throw new PatchProofError('Patch proof requires bounded ordinary files');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum || before.dev !== selected.dev || before.ino !== selected.ino) throw new PatchProofError('Patch proof file identity changed');
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
    const result = buffer.subarray(0, length);
    if (result.length > maximum || result.length !== before.size || stable(before) !== stable(fstatSync(fd)) || stable(selected) !== stable(lstatSync(file))) throw new PatchProofError('Patch proof file changed during reading');
    return result;
  } finally { closeSync(fd); }
}
export { bytes as readBoundedOrdinaryFile };

function ordinaryPath(root, name, directory = false) {
  if (!relative(name)) throw new PatchProofError('Invalid patch proof relative path');
  let current = root;
  const parts = name.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch { throw new PatchProofError(`Required proof path is missing or unreadable: ${name}`); }
    if (info.isSymbolicLink() || (index < parts.length - 1 || directory ? !info.isDirectory() : !info.isFile())) throw new PatchProofError('Patch proof path is substituted');
  }
  return current;
}

export function readPatchContract(base) {
  const file = ordinaryPath(base, 'deploy/dependency_patch_contract.py');
  const content = bytes(file, 65536).toString('utf8');
  const prefix = 'APPROVED_PATCH = ';
  if (!content.startsWith(prefix) || !content.endsWith('\n')) throw new PatchProofError('Unknown patch contract format');
  const value = JSON.parse(content.slice(prefix.length));
  if (!object(value)) throw new PatchProofError('Invalid approved patch contract');
  const identity = value.schemaVersion === 1 && value.package === 'picomatch' && value.version === '4.0.7' && value.patchPath === 'patches/picomatch@4.0.7.patch';
  const digests = /^[a-f0-9]{64}$/.test(value.patchSha256 ?? '') && /^[a-f0-9]{64}$/.test(value.lockPatchHash ?? '') && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value.upstreamIntegrity ?? '');
  const files = object(value.files) && Object.keys(value.files).length > 0 && Object.keys(value.files).length <= 100;
  if (!identity || !digests || !files) throw new PatchProofError('Invalid approved patch contract');
  for (const [name, digest] of Object.entries(value.files)) if (!relative(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new PatchProofError('Invalid package file contract');
  for (const required of ['package.json', 'index.js', 'lib/parse.js', 'lib/picomatch.js']) if (!value.files[required]) throw new PatchProofError('Incomplete package file contract');
  return { ...value, contractSha256: hash(Buffer.from(content)) };
}

function verifyPackage(directory, contract) {
  const observed = new Map(); let total = 0;
  const directories = new Set(Object.keys(contract.files).flatMap(name => {
    const parts = name.split('/'); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  }));
  const visit = (current, prefix = '', depth = 0) => {
    if (depth > 8) throw new PatchProofError('Package nesting exceeds proof budget');
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const name = prefix + item.name, file = path.join(current, item.name);
      if (item.isSymbolicLink()) throw new PatchProofError('Patched package contains a substituted file');
      if (item.isDirectory()) {
        if (!directories.has(name)) throw new PatchProofError('Patched package has an unapproved directory');
        visit(file, name + '/', depth + 1);
      }
      else {
        if (!item.isFile() || !Object.hasOwn(contract.files, name)) throw new PatchProofError('Patched package has unapproved content');
        const data = bytes(file); total += data.length;
        if (total > 8 * 1024 * 1024 || hash(data) !== contract.files[name]) throw new PatchProofError('Installed picomatch is not the approved patched content');
        observed.set(name, hash(data));
      }
    }
  };
  visit(directory);
  if (observed.size !== Object.keys(contract.files).length) throw new PatchProofError('Installed patched package is incomplete');
  const manifest = JSON.parse(bytes(path.join(directory, 'package.json')).toString('utf8'));
  if (manifest.name !== contract.package || manifest.version !== contract.version) throw new PatchProofError('Patched package identity changed');
  return { path: directory, files: Object.fromEntries([...observed].sort()) };
}

function verifyLock(lock, workspace, contract) {
  const mapping = workspace.patchedDependencies;
  if (!object(mapping) || Object.keys(mapping).length !== 1 || mapping['picomatch@4.0.7'] !== contract.patchPath) throw new PatchProofError('Workspace patch mapping differs from approval');
  const block = lock.match(/^patchedDependencies:\r?\n((?:[ \t].*\r?\n|\r?\n)*)/m);
  if (!block || lock.match(/^patchedDependencies:/gm)?.length !== 1) throw new PatchProofError('Lock has no unique patch mapping');
  const lines = block[1].trimEnd().split(/\r?\n/);
  if (lines.length !== 1 || lines[0] !== `  picomatch@4.0.7: ${contract.lockPatchHash}`) throw new PatchProofError('Lock patch identity differs from approval');
  const packages = lock.split(/^packages:\r?\n/m)[1]?.split(/^snapshots:\r?\n/m)[0];
  if (!packages || packages.match(/^  picomatch@4\.0\.7:/gm)?.length !== 1 || !packages.includes(`  picomatch@4.0.7:\n    resolution: {integrity: ${contract.upstreamIntegrity}}`)) throw new PatchProofError('Lock upstream identity differs from approval');
  const snapshots = lock.split(/^snapshots:\r?\n/m)[1];
  if (!snapshots || !snapshots.includes(`  picomatch@4.0.7(patch_hash=${contract.lockPatchHash}): {}`) || /^  picomatch@4\.0\.7: /m.test(snapshots)) throw new PatchProofError('Lock snapshot does not bind the patch');
  for (const line of snapshots.split(/\r?\n/).filter(line => /^      picomatch:/.test(line))) if (line !== `      picomatch: 4.0.7(patch_hash=${contract.lockPatchHash})`) throw new PatchProofError('Lock retains an unpatched picomatch resolution');
}

function installedCopies(modules, store, contract) {
  const pending = [{ directory: modules, depth: 0 }], resolved = new Set(); let entries = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop();
    if (depth > 64) throw new PatchProofError('Installed dependency nesting exceeds proof budget');
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 100000) throw new PatchProofError('Installed dependency tree exceeds proof budget');
      const selected = path.join(directory, item.name);
      if (path.basename(directory) === 'node_modules' && item.name === 'picomatch') {
        const target = realpathSync(selected);
        if (!inside(store, target) || !lstatSync(target).isDirectory()) throw new PatchProofError('Installed picomatch reference escaped the verified store');
        resolved.add(target);
      }
      // Do not follow links: each physical store copy is reached independently,
      // and every picomatch alias (including nested shadow copies) is checked above.
      if (item.isDirectory() && !item.isSymbolicLink()) pending.push({ directory: selected, depth: depth + 1 });
    }
  }
  return [...resolved].sort().map(directory => verifyPackage(directory, contract));
}

/** Verify every installed copy and every installed direct consumer, not a saved attestation. */
function verifyInstalled(base) {
  base = realpathSync(base);
  const contract = readPatchContract(base);
  const patch = bytes(ordinaryPath(base, contract.patchPath), 65536);
  if (readdirSync(path.join(base, 'patches')).length !== 1) throw new PatchProofError('Only the approved patch may appear in patches');
  if (patch.includes(13) || hash(patch) !== contract.patchSha256 || hash(patch) !== contract.lockPatchHash) throw new PatchProofError('Approved LF patch bytes or lock patch digest changed');
  const workspace = JSON.parse(bytes(ordinaryPath(base, 'pnpm-workspace.yaml')).toString('utf8'));
  const lockBytes = bytes(ordinaryPath(base, 'pnpm-lock.yaml'), 8 * 1024 * 1024), lock = lockBytes.toString('utf8').replaceAll('\r\n', '\n');
  verifyLock(lock, workspace, contract);
  const store = ordinaryPath(base, 'node_modules/.pnpm', true);
  const packages = [], instances = installedCopies(path.join(base, 'node_modules'), store, contract);
  const entries = readdirSync(store, { withFileTypes: true });
  if (entries.length > 5000) throw new PatchProofError('Installed store exceeds proof budget');
  for (const entry of entries) {
    if (entry.name.startsWith('picomatch@') && entry.isSymbolicLink()) throw new PatchProofError('Patched package store entry is substituted');
    if (entry.name === 'node_modules' || !entry.isDirectory()) continue;
    const root = path.join(store, entry.name, 'node_modules');
    if (!existsSync(root)) continue;
    ordinaryPath(store, entry.name + '/node_modules', true);
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      const directory = path.join(root, item.name);
      if (item.name.startsWith('@')) for (const child of readdirSync(directory, { withFileTypes: true })) {
        if (child.isDirectory() && !child.isSymbolicLink()) packages.push(path.join(directory, child.name));
      }
      else packages.push(directory);
    }
  }
  if (packages.length > 5000) throw new PatchProofError('Installed package count exceeds proof budget');
  const consumers = [];
  for (const directory of [base, ...packages]) {
    const file = path.join(directory, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(bytes(file).toString('utf8'));
    if (manifest.name === 'picomatch' && !instances.some(item => item.path === directory)) throw new PatchProofError('Unrecognized installed picomatch package location');
    if (![manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies, directory === base ? manifest.devDependencies : null].some(deps => object(deps) && Object.hasOwn(deps, 'picomatch'))) continue;
    const resolved = realpathSync(createRequire(file).resolve('picomatch/package.json'));
    if (!inside(store, resolved)) throw new PatchProofError('Consumer resolves picomatch outside the verified store');
    consumers.push({ package: manifest.name, path: directory, resolved: path.dirname(resolved) });
  }
  if (!instances.length || !consumers.length || consumers.some(item => !instances.some(instance => instance.path === item.resolved))) throw new PatchProofError('Installed consumers do not all resolve verified patched instances');
  // A top-level injected alias must not override the verified dependency graph.
  for (const alias of ['node_modules/picomatch', 'node_modules/.pnpm/node_modules/picomatch']) if (existsSync(path.join(base, alias))) {
    const resolved = realpathSync(path.join(base, alias));
    if (!instances.some(item => item.path === resolved)) throw new PatchProofError('Top-level picomatch alias is not verified');
  }
  const rel = value => path.relative(base, value).split(path.sep).join('/');
  return { package: contract.package, version: contract.version, patchPath: contract.patchPath, patchSha256: contract.patchSha256, lockPatchHash: contract.lockPatchHash, contractSha256: contract.contractSha256, lockSha256: hash(lockBytes), upstreamIntegrity: contract.upstreamIntegrity,
    instances: instances.map(item => ({ ...item, path: rel(item.path) })),
    consumers: consumers.map(item => ({ ...item, path: rel(item.path), resolved: rel(item.resolved) })) };
}

export function verifyInstalledPicomatch(base) {
  try { return verifyInstalled(base); }
  catch (error) {
    if (error instanceof PatchProofError) throw error;
    if (error instanceof SyntaxError) throw new PatchProofError('Invalid JSON in patch contract, workspace or installed package');
    if (error?.code === 'MODULE_NOT_FOUND') throw new PatchProofError('An installed consumer cannot resolve picomatch');
    throw new PatchProofError('Patch proof could not read the required ordinary installed files');
  }
}
