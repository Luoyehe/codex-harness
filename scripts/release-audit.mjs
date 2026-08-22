// Release audit: walk the repo (excluding deps/build) and flag anything that
// should not ship — credentials, internal hosts/paths, personal traces,
// private-key material, editor/OS junk. Exit 1 if anything is flagged.
//
// Extra deployment-specific patterns can be passed without committing them:
//   AUDIT_EXTRA="literal1|literal2" node scripts/release-audit.mjs .
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] ?? ".";
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "dev-codex-home", ".zcode"]);

const RULES = [
  // Structural credential shapes (no real secrets live in this file!).
  { name: "zhipu-key", re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{12,}\b/ },
  { name: "sk-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "ghp-key", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "private-ip", re: /\b(192\.168|10\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { name: "private-key", re: /BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY/ },
  { name: "argon2-hash", re: /\$argon2id\$/ },
  { name: "assign-secret", re: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["'][^"'<>{}]{12,}/i },
  { name: "email", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
];
// Deployment-specific literals (old credentials, internal hostnames, personal
// project names…) go here via env so they never enter version control:
//   AUDIT_EXTRA="literal1|literal2" node scripts/release-audit.mjs .
if (process.env.AUDIT_EXTRA) {
  RULES.push({ name: "audit-extra", re: new RegExp(process.env.AUDIT_EXTRA, "i") });
}

const JUNK = /\.(tgz|zip|bak|log|tmp|DS_Store|pem|key|crt|env)$|Thumbs\.db$/i;
// .env.example-style files and the codex env template are fine; flag real .env only.

const hits = [];
const junk = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full);
      continue;
    }
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    if (JUNK.test(entry) && !/\.example$/.test(entry)) {
      junk.push(rel);
      continue;
    }
    if (entry === ".env" || entry === ".env.local") {
      junk.push(rel);
      continue;
    }
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue; // binary
    }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        const m = rule.re.exec(line);
        if (!m) continue;
        if (rule.name === "email" && /(example\.(com|org)|localhost|noreply\.github|users\.noreply)/i.test(m[0])) continue;
        if (rule.name === "private-ip" && m[0].startsWith("127.")) continue;
        hits.push(`${rel}:${i + 1} [${rule.name}] ${line.trim().slice(0, 110)}`);
      }
    });
  }
}

walk(ROOT);
console.log(`=== rule hits: ${hits.length}, junk files: ${junk.length} ===`);
for (const h of hits) console.log("HIT " + h);
for (const j of junk) console.log("JUNK " + j);
process.exit(hits.length + junk.length > 0 ? 1 : 0);
