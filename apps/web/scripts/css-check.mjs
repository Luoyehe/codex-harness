// Locate unterminated strings / braces in styles.css.
// Exits non-zero when issues are found (usable as a pre-commit check).
import { readFileSync } from "node:fs";

const text = readFileSync("src/styles.css", "utf8");
const lines = text.split("\n");
let issues = 0;

// Brace balance, tracking block comments.
let depth = 0;
let inComment = false;
const stripComment = (l) => {
  if (inComment) {
    const end = l.indexOf("*/");
    if (end === -1) return "";
    inComment = false;
    l = l.slice(end + 2);
  }
  const start = l.indexOf("/*");
  if (start !== -1) {
    if (l.indexOf("*/", start) === -1) inComment = true;
    l = l.slice(0, start);
  }
  return l;
};

lines.forEach((line, i) => {
  const l = stripComment(line);
  for (const ch of l) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
  }
  if (depth < 0) {
    console.log(`EXTRA } at line ${i + 1}: ${line.trim()}`);
    issues++;
    depth = 0;
  }
});
console.log("final brace depth:", depth);
if (depth !== 0) issues++;

// Odd double quotes per logical line (quotes are rare in this css).
lines.forEach((line, i) => {
  const count = (stripComment(line).match(/"/g) ?? []).length;
  if (count % 2 === 1) {
    console.log(`ODD QUOTES line ${i + 1}: ${line.trim()}`);
    issues++;
  }
});

if (issues > 0) {
  console.error(`css-check: ${issues} issue(s) found`);
  process.exit(1);
}
console.log("css-check: OK");
