// Run only from the installed, root-controlled checkout. Candidate files are
// data; none of their modules, hooks or npmrc files are loaded.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAlias, isCollection, isPair, parseAllDocuments } from "yaml";

const manifestPaths = ["package.json", "apps/gateway/package.json", "apps/web/package.json"];
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?(?!constructor$|prototype$)[a-z0-9][a-z0-9._-]*$/;
const version = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const range = /^[0-9A-Za-z.*+^~<>=| -]+$/;
const fields = ["dependencies", "devDependencies", "optionalDependencies"];
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
class DependencyInputError extends Error {}
function requireValue(value, message) { if (!value) throw new DependencyInputError(message); }
function keysOnly(value, keys, label) {
  requireValue(plain(value) && Object.keys(value).every(key => keys.includes(key)), `unsupported ${label}`);
}
function stable(info) { return [info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(":"); }

export function readInput(root, relative, limit) {
  const target = path.resolve(root, relative);
  requireValue(target.startsWith(path.resolve(root) + path.sep), "input escaped candidate");
  const parents = [];
  for (let current = path.dirname(target);; current = path.dirname(current)) {
    const info = lstatSync(current, { bigint: true });
    requireValue(info.isDirectory() && !info.isSymbolicLink(), "input has a directory alias");
    if (process.platform !== "win32") requireValue(info.uid === 0n && (info.mode & 0o022n) === 0n, "input ancestor is not root-controlled");
    parents.push([current, stable(info)]);
    if (current === path.parse(current).root) break;
  }
  const before = lstatSync(target, { bigint: true });
  requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(limit), "unsafe or oversized input");
  if (process.platform !== "win32") requireValue(before.uid === 0n && (before.mode & 0o022n) === 0n, "input is not root-controlled");
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    requireValue(stable(before) === stable(fstatSync(fd, { bigint: true })), "input changed while opening");
    const data = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (!count) break;
      length += count;
    }
    requireValue(length <= limit && BigInt(length) === before.size, "input grew while reading");
    requireValue(stable(before) === stable(fstatSync(fd, { bigint: true })) && stable(before) === stable(lstatSync(target, { bigint: true })), "input changed while reading");
    for (const [parent, identity] of parents) requireValue(stable(lstatSync(parent, { bigint: true })) === identity, "input ancestor changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, length));
  } finally { closeSync(fd); }
}

function parseYaml(text) {
  const docs = parseAllDocuments(text, { strict: true, uniqueKeys: true });
  requireValue(docs.length === 1 && !docs[0].errors.length && !docs[0].warnings.length, "invalid dependency YAML");
  let count = 0;
  const walk = (node, depth = 0) => {
    requireValue(++count <= 100000 && depth <= 32 && !isAlias(node) && !node?.tag, "unsupported YAML graph");
    if (isCollection(node)) for (const item of node.items) walk(item, depth + 1);
    else if (isPair(node)) {
      requireValue(!["__proto__", "constructor", "prototype"].includes(node.key?.value), "unsupported YAML key");
      walk(node.key, depth + 1); walk(node.value, depth + 1);
    }
  };
  walk(docs[0].contents);
  return docs[0].toJS({ maxAliasCount: 0 });
}

function dependencies(value) {
  requireValue(plain(value), "invalid dependency map");
  for (const [name, specifier] of Object.entries(value)) {
    requireValue(packageName.test(name) && !name.startsWith("@jsr/") && typeof specifier === "string" && specifier.length <= 256 && range.test(specifier), "only npm registry dependency ranges are supported");
  }
  return value;
}

export function projectInputs(texts, packageManager) {
  requireValue(/^pnpm@\d+\.\d+\.\d+$/.test(packageManager), "trusted updater must pin pnpm");
  const files = Object.create(null);
  const manifests = manifestPaths.map(relative => {
    const input = JSON.parse(texts[relative]);
    requireValue(plain(input) && typeof input.name === "string" && packageName.test(input.name), "invalid workspace package name");
    if (relative === "package.json") requireValue(input.packageManager === packageManager, "candidate pnpm differs; repair the trusted toolchain first");
    const clean = { name: input.name, private: true };
    if (relative === "package.json") clean.packageManager = packageManager;
    for (const field of fields) if (input[field] !== undefined) clean[field] = dependencies(input[field]);
    files[relative] = JSON.stringify(clean, null, 2) + "\n";
    return clean;
  });
  const workspace = parseYaml(texts["pnpm-workspace.yaml"]);
  keysOnly(workspace, ["packages", "allowBuilds", "overrides"], "workspace configuration");
  requireValue(JSON.stringify(workspace.packages) === '["apps/*"]', "unsupported workspace layout");
  const overrides = workspace.overrides || {};
  requireValue(plain(overrides), "invalid overrides");
  for (const [selector, replacement] of Object.entries(overrides)) {
    requireValue(/^[a-zA-Z0-9@/._+^~<>=| *-]+$/.test(selector) && typeof replacement === "string" && range.test(replacement), "unsupported override source");
  }
  const allowBuilds = workspace.allowBuilds || {};
  requireValue(plain(allowBuilds) && Object.entries(allowBuilds).every(([name, allowed]) => packageName.test(name) && typeof allowed === "boolean"), "unsupported build policy");
  const lock = parseYaml(texts["pnpm-lock.yaml"]);
  keysOnly(lock, ["lockfileVersion", "settings", "overrides", "importers", "packages", "snapshots"], "lockfile configuration");
  requireValue(String(lock.lockfileVersion) === "9.0", "unsupported lockfile version");
  keysOnly(lock.settings, ["autoInstallPeers", "excludeLinksFromLockfile"], "lockfile settings");
  requireValue(Object.values(lock.settings).every(value => typeof value === "boolean"), "invalid lock settings");
  requireValue(plain(lock.overrides || {}) && JSON.stringify(Object.entries(lock.overrides || {}).sort()) === JSON.stringify(Object.entries(overrides).sort()), "workspace overrides differ from lockfile");
  requireValue(plain(lock.packages) && plain(lock.snapshots), "missing locked packages");
  for (const [name, entry] of Object.entries(lock.packages)) {
    const at = name.lastIndexOf("@");
    requireValue(packageName.test(name.slice(0, at)) && !name.startsWith("@jsr/") && version.test(name.slice(at + 1)), "non-registry locked package");
    keysOnly(entry, ["resolution", "engines", "cpu", "os", "libc", "hasBin", "peerDependencies", "peerDependenciesMeta", "deprecated", "requiresBuild"], "locked package metadata");
    keysOnly(entry.resolution, ["integrity"], "package resolution");
    requireValue(/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.resolution.integrity), "package must have sha512 registry integrity");
    if (entry.peerDependencies) dependencies(entry.peerDependencies);
    if (entry.peerDependenciesMeta) {
      requireValue(plain(entry.peerDependenciesMeta), "invalid peer metadata");
      for (const [peer, metadata] of Object.entries(entry.peerDependenciesMeta)) {
        requireValue(packageName.test(peer), "invalid peer name");
        keysOnly(metadata, ["optional"], "peer metadata");
        requireValue(typeof metadata.optional === "boolean", "invalid peer metadata");
      }
    }
  }
  const reference = (name, value) => {
    requireValue(packageName.test(name) && typeof value === "string" && /^[A-Za-z0-9@/._+()\-]+$/.test(value), "non-registry dependency reference");
    const bare = value.split("(", 1)[0];
    requireValue(version.test(bare) && Object.hasOwn(lock.packages, `${name}@${bare}`), "unresolved locked dependency");
  };
  for (const [name, entry] of Object.entries(lock.snapshots)) {
    requireValue(/^[A-Za-z0-9@/._+()\-]+$/.test(name) && Object.hasOwn(lock.packages, name.split("(", 1)[0]), "invalid snapshot package");
    keysOnly(entry, ["dependencies", "optionalDependencies", "transitivePeerDependencies", "optional"], "snapshot metadata");
    if (entry.optional !== undefined) requireValue(typeof entry.optional === "boolean", "invalid optional snapshot");
    if (entry.transitivePeerDependencies !== undefined) requireValue(Array.isArray(entry.transitivePeerDependencies) && entry.transitivePeerDependencies.every(name => typeof name === "string" && packageName.test(name)), "invalid transitive peer list");
    for (const field of ["dependencies", "optionalDependencies"]) if (entry[field]) {
      requireValue(plain(entry[field]), "invalid snapshot dependencies");
      for (const [dependency, value] of Object.entries(entry[field])) reference(dependency, value);
    }
  }
  keysOnly(lock.importers, [".", "apps/gateway", "apps/web"], "lock importers");
  requireValue(Object.keys(lock.importers).length === 3, "missing lock importer");
  for (const [index, name] of [".", "apps/gateway", "apps/web"].entries()) {
    const importer = lock.importers[name];
    keysOnly(importer, fields, "importer metadata");
    for (const field of fields) {
      const expected = manifests[index][field] || {}, actual = importer[field] || {};
      requireValue(plain(actual) && Object.keys(actual).length === Object.keys(expected).length, "manifest and lock differ");
      for (const [dependency, specifier] of Object.entries(expected)) {
        keysOnly(actual[dependency], ["specifier", "version"], "importer dependency");
        requireValue(actual[dependency].specifier === specifier, "manifest and lock specifier differ");
        reference(dependency, actual[dependency].version);
      }
    }
  }
  // JSON is a YAML subset. Hand pnpm the inspected data, not the original YAML
  // graph or an uninspected configuration file.
  files["pnpm-lock.yaml"] = JSON.stringify(lock, null, 2) + "\n";
  files["pnpm-workspace.yaml"] = JSON.stringify({ packages: ["apps/*"], allowBuilds, overrides }, null, 2) + "\n";
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { files, digest };
}

export function prepareInputs(candidate, destination, trustedRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)))) {
  const current = JSON.parse(readInput(trustedRoot, "package.json", 256 * 1024));
  const texts = Object.create(null);
  for (const relative of [...manifestPaths, "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    texts[relative] = readInput(candidate, relative, relative === "pnpm-lock.yaml" ? 4 * 1024 * 1024 : 256 * 1024);
  }
  const { files, digest } = projectInputs(texts, current.packageManager);
  return writeInputs({ files, digest }, destination);
}

export function writeInputs({ files, digest }, destination) {
  const names = [...manifestPaths, "pnpm-lock.yaml", "pnpm-workspace.yaml"];
  keysOnly(files, names, "projected files");
  requireValue(names.every(name => typeof files[name] === "string") && /^[a-f0-9]{64}$/.test(digest), "invalid projected input");
  // The enclosing transaction remains 0700. Its data-only bind source must be
  // readable by DynamicUser even when the root updater runs with umask 077.
  const previousMask = process.umask(0o022);
  try {
    mkdirSync(destination, { mode: 0o755 });
    for (const relative of names) {
      mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true, mode: 0o755 });
      writeFileSync(path.join(destination, relative), files[relative], { flag: "wx", mode: 0o644 });
    }
    writeFileSync(path.join(destination, "dependency-inputs.json"), JSON.stringify({ format: 1, dependencyInputs: digest }) + "\n", { flag: "wx", mode: 0o644 });
  } finally {
    process.umask(previousMask);
  }
  return digest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length === 4, "usage: dependency-inputs.mjs CANDIDATE DESTINATION");
    process.stdout.write(prepareInputs(process.argv[2], process.argv[3]) + "\n");
  } catch (error) {
    process.stderr.write(`dependency preparation refused: ${error instanceof DependencyInputError ? error.message : "invalid or unreadable dependency data"}\n`);
    process.exitCode = 1;
  }
}
