import { canonical, object, onlyKeys, type JsonObject, type JsonValue } from './types.js';

type Access = 'read' | 'write' | 'deny';
interface Rule { selector: string; access: Access }
interface FileSystemRules { rules: Rule[]; selectors: Map<string, Set<Access>>; depth: JsonValue }

function selector(value: JsonObject): string {
  onlyKeys(value, value.type === 'path' ? ['type', 'path'] : value.type === 'glob_pattern' ? ['type', 'pattern'] : ['type', 'value']);
  if (value.type === 'special') {
    const special = object(value.value);
    onlyKeys(special, special.kind === 'unknown' ? ['kind', 'path', 'subpath'] : special.kind === 'project_roots' ? ['kind', 'subpath'] : ['kind']);
  }
  // Compare the wire selector, without resolving paths, aliases or glob matches.
  return canonical(value);
}

function fileSystemRules(input: JsonValue | undefined): FileSystemRules {
  const value = input == null ? {} : object(input);
  onlyKeys(value, ['read', 'write', 'entries', 'globScanMaxDepth']);
  const rules: Rule[] = [];
  if (value.entries != null) {
    // Official Option<Vec<...>> conversion: an array, including [], supersedes
    // legacy projections; null and omission use the legacy lists instead.
    for (const entry of value.entries as JsonValue[]) {
      const rule = object(entry); onlyKeys(rule, ['path', 'access']);
      const path = object(rule.path);
      rules.push({ selector: selector(path), access: rule.access as Access });
    }
  } else {
    for (const access of ['read', 'write'] as const) for (const path of (value[access] ?? []) as JsonValue[]) {
      rules.push({ selector: canonical({ type: 'path', path }), access });
    }
  }
  const selectors = new Map<string, Set<Access>>();
  for (const rule of rules) {
    let modes = selectors.get(rule.selector);
    if (!modes) { modes = new Set(); selectors.set(rule.selector, modes); }
    modes.add(rule.access);
  }
  return { rules, selectors, depth: value.globScanMaxDepth ?? null };
}

function networkEnabled(input: JsonValue | undefined): boolean {
  if (input == null) return false;
  const value = object(input); onlyKeys(value, ['enabled']);
  return value.enabled === true;
}

// Both inputs must first pass the pinned official schemas. Keep comparison
// separate from the response: normalization here never changes native payloads.
export function permissionsWithinRequest(granted: JsonObject, requested: JsonObject): boolean {
  onlyKeys(granted, ['network', 'fileSystem']); onlyKeys(requested, ['network', 'fileSystem']);
  const grantedNetwork = networkEnabled(granted.network), answer = fileSystemRules(granted.fileSystem);
  const emptyFileSystem = answer.rules.length === 0 && answer.depth === null;
  // Only interpret requested categories that the answer retains. A complete
  // refusal remains possible when a schema-valid request has future nested fields.
  if (grantedNetwork && !networkEnabled(requested.network)) return false;
  if (emptyFileSystem) return true;
  const original = fileSystemRules(requested.fileSystem);
  const hasWrite = answer.rules.some(rule => rule.access === 'write');

  // Exact duplicates and order do not change selector/access rules. Every
  // positive grant needs its own requested selector and a nonincreasing mode.
  for (const rule of answer.rules) {
    const modes = original.selectors.get(rule.selector);
    if (!modes || (rule.access === 'write' && !modes.has('write')) || (rule.access === 'read' && !modes.has('read') && !modes.has('write'))) return false;
  }
  for (const rule of original.rules) {
    const modes = answer.selectors.get(rule.selector);
    if (rule.access === 'deny' && !modes?.has('deny')) return false;
    // A more specific read can restrict an enclosing write. Preserve all reads
    // while any write remains; selector overlap is deliberately not inferred.
    if (hasWrite && rule.access === 'read' && !modes?.has('read') && !modes?.has('deny')) return false;
  }
  // Depth is not a permission ordering. Even literal supplemental rules can be
  // combined with a baseline policy, whose scan-dependent restrictions are not
  // available here. Preserve the requested Option value for every nonempty
  // filesystem response, including deny-only rules and depth-only responses.
  if (answer.depth !== original.depth) return false;
  return true;
}
