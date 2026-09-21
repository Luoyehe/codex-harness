// Release audit: walk a repository tree and flag credentials, internal hosts,
// private-key material, placeholders, and junk files. Findings intentionally
// contain only file/line/rule metadata: echoing the matching line would leak
// the very value this command is meant to catch into CI logs.
//
// Deployment-specific *literal* values can be supplied without committing
// them. Separate values with `|`; they are escaped, not treated as regexes:
//   AUDIT_EXTRA="literal1|literal2" node scripts/release-audit.mjs .
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = realpathSync(process.argv[2] ?? ".");
// Build output is part of the deployed artifact and may contain values injected
// by a bundler environment, so it must be scanned. Only dependency/object
// stores that are never published with the project are skipped.
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const FORBIDDEN_DIRS = new Set(["dev-codex-home", ".zcode"]);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_TREE_ENTRIES = 250_000;
const MAX_TREE_DEPTH = 64;

const RULES = [
  { name: "zhipu-key", re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{12,}\b/i },
  { name: "sk-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "private-ip", re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { name: "private-key", re: /BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/ },
  { name: "argon2-hash", re: /\$argon2id\$/ },
  // Match committed string literals, not a quoted shell command substitution
  // such as API_KEY="$(read_secret)".  The latter contains no credential and
  // otherwise turns safe runtime loading into a permanent false positive.
  { name: "assign-secret", re: /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["'](?!\$\()[^"'<>{}]{12,}/i },
  { name: "email", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: "owner-placeholder", re: /github\.com\/OWNER\//i },
];

const extraLiterals = (process.env.AUDIT_EXTRA ?? "")
  .split("|")
  .map((value) => value.trim())
  .filter(Boolean);

const JUNK = /\.(?:tgz|zip|bak|log|tmp|DS_Store|pem|key|crt|env)$|Thumbs\.db$/i;
const hits = [];
const junk = [];
const skippedLarge = [];
const unreadable = [];
let visitedEntries = 0;
let treeBudgetExceeded = false;

function ruleMatches(value, rule) {
  rule.re.lastIndex = 0;
  const matches = value.match(rule.re) ?? [];
  rule.re.lastIndex = 0;
  if (rule.name !== "email") return matches.length > 0;
  return matches.some((email) => !/^(?:example\.(?:com|org)|localhost|(?:users\.)?noreply\.github\.com)$/i.test(email.split("@")[1]));
}

function pathFindings(value) {
  const names = RULES.filter((rule) => ruleMatches(value, rule)).map((rule) => rule.name);
  if (/[\u0000-\u001f\u007f]/.test(value)) names.push("unsafe-path");
  const folded = value.toLocaleLowerCase("en-US");
  if (extraLiterals.some((literal) => folded.includes(literal.toLocaleLowerCase("en-US")))) names.push("audit-extra");
  return names;
}

function displayPath(value, findings = pathFindings(value)) {
  if (!findings.length) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `<redacted-path:${digest}>`;
}

function recordRules(text, rel) {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      // An example earlier on the same line must not hide a private address.
      // Only exact public fixture/noreply domains are exempt, not substrings
      // in a local part or in an unrelated domain's prefix.
      if (!ruleMatches(line, rule)) continue;
      hits.push(`${rel}:${index + 1} [${rule.name}]`);
    }
    for (const literal of extraLiterals) {
      if (line.toLocaleLowerCase("en-US").includes(literal.toLocaleLowerCase("en-US"))) {
        hits.push(`${rel}:${index + 1} [audit-extra]`);
      }
    }
  });
}

function walk(dir, depth = 0) {
  if (treeBudgetExceeded) return;
  if (depth > MAX_TREE_DEPTH) { treeBudgetExceeded = true; return; }
  let entries;
  try { entries = readdirSync(dir); }
  catch {
    const rel = path.relative(ROOT, dir).replace(/\\/g, "/") || ".";
    unreadable.push(displayPath(rel));
    return;
  }
  for (const entry of entries) {
    if (++visitedEntries > MAX_TREE_ENTRIES) { treeBudgetExceeded = true; break; }
    const full = path.join(dir, entry);
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    const relFindings = pathFindings(rel);
    const reportedRel = displayPath(rel, relFindings);
    for (const name of relFindings) hits.push(`${reportedRel}:path [${name}]`);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      unreadable.push(reportedRel);
      continue;
    }
    // Never follow a repository symlink and accidentally inspect files outside
    // the requested release tree. Silently skipping it would make a successful
    // audit incomplete, so require a human to remove or inspect it explicitly.
    if (stat.isSymbolicLink()) {
      unreadable.push(reportedRel);
      continue;
    }
    if (stat.isDirectory()) {
      const foldedEntry = entry.toLocaleLowerCase("en-US");
      if (FORBIDDEN_DIRS.has(foldedEntry)) {
        // These are private development state, never release inputs. Flag the
        // directory itself without reading or echoing anything it contains.
        junk.push(`${reportedRel}/`);
      } else if (!SKIP_DIRS.has(foldedEntry)) walk(full, depth + 1);
      continue;
    }
    // FIFOs/devices/sockets can block or have non-file semantics. A release
    // tree containing one is unsupported and cannot be declared fully scanned.
    if (!stat.isFile()) {
      unreadable.push(reportedRel);
      continue;
    }
    if (JUNK.test(entry) && !/\.example$/i.test(entry)) {
      junk.push(reportedRel);
      continue;
    }
    if (/^\.env(?:\.|$)/i.test(entry) && !/\.example$/i.test(entry)) {
      junk.push(reportedRel);
      continue;
    }
    if (stat.size > MAX_TEXT_BYTES) {
      skippedLarge.push(reportedRel);
      continue;
    }
    try {
      recordRules(readFileSync(full, "utf8"), reportedRel);
    } catch {
      unreadable.push(reportedRel);
    }
  }
}

walk(ROOT);
console.log(`=== rule hits: ${hits.length}, junk files: ${junk.length}, large files skipped: ${skippedLarge.length}, unreadable: ${unreadable.length} ===`);
for (const hit of hits) console.log(`HIT ${hit}`);
for (const file of junk) console.log(`JUNK ${file}`);
for (const file of skippedLarge) console.log(`SKIP-LARGE ${file}`);
for (const file of unreadable) console.log(`UNREADABLE ${file}`);
if (treeBudgetExceeded) console.log("TREE-BUDGET-EXCEEDED");
if (skippedLarge.length + unreadable.length > 0 || treeBudgetExceeded) console.error("Audit incomplete: unscanned files must be investigated before release.");
process.exitCode = hits.length + junk.length + skippedLarge.length + unreadable.length + Number(treeBudgetExceeded) > 0 ? 1 : 0;
