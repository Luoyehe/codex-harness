// Release audit: walk a repository tree and flag credentials, internal hosts,
// private-key material, placeholders, and junk files. Findings intentionally
// contain only file/line/rule metadata: echoing the matching line would leak
// the very value this command is meant to catch into CI logs.
//
// Deployment-specific *literal* values can be supplied without committing
// them. Separate values with `|`; they are escaped, not treated as regexes:
//   AUDIT_EXTRA="literal1|literal2" node scripts/release-audit.mjs .
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const ROOT = realpathSync(process.argv[2] ?? ".");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "dev-codex-home", ".zcode"]);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const RULES = [
  { name: "zhipu-key", re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{12,}\b/i },
  { name: "sk-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "private-ip", re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { name: "private-key", re: /BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/ },
  { name: "argon2-hash", re: /\$argon2id\$/ },
  // Match committed string literals, not a quoted shell command substitution
  // such as API_KEY="$(read_secret)".  The latter contains no credential and
  // otherwise turns safe runtime loading into a permanent false positive.
  { name: "assign-secret", re: /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["'](?!\$\()[^"'<>{}]{12,}/i },
  { name: "email", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
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

function recordRules(text, rel) {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      const match = rule.re.exec(line);
      if (!match) continue;
      if (rule.name === "email" && /(?:example\.(?:com|org)|localhost|noreply\.github|users\.noreply)/i.test(match[0])) continue;
      hits.push(`${rel}:${index + 1} [${rule.name}]`);
    }
    for (const literal of extraLiterals) {
      if (line.toLocaleLowerCase("en-US").includes(literal.toLocaleLowerCase("en-US"))) {
        hits.push(`${rel}:${index + 1} [audit-extra]`);
      }
    }
  });
}

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); }
  catch { unreadable.push(path.relative(ROOT, dir) || "."); return; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      unreadable.push(rel);
      continue;
    }
    // Never follow a repository symlink and accidentally inspect files outside
    // the requested release tree.
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full);
      continue;
    }
    if (JUNK.test(entry) && !/\.example$/i.test(entry)) {
      junk.push(rel);
      continue;
    }
    if (entry === ".env" || entry === ".env.local") {
      junk.push(rel);
      continue;
    }
    if (stat.size > MAX_TEXT_BYTES) {
      skippedLarge.push(rel);
      continue;
    }
    try {
      recordRules(readFileSync(full, "utf8"), rel);
    } catch {
      unreadable.push(rel);
    }
  }
}

walk(ROOT);
console.log(`=== rule hits: ${hits.length}, junk files: ${junk.length}, large files skipped: ${skippedLarge.length}, unreadable: ${unreadable.length} ===`);
for (const hit of hits) console.log(`HIT ${hit}`);
for (const file of junk) console.log(`JUNK ${file}`);
for (const file of skippedLarge) console.log(`SKIP-LARGE ${file}`);
for (const file of unreadable) console.log(`UNREADABLE ${file}`);
if (skippedLarge.length + unreadable.length > 0) console.error("Audit incomplete: unscanned files must be investigated before release.");
process.exitCode = hits.length + junk.length + skippedLarge.length + unreadable.length > 0 ? 1 : 0;
