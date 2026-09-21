const MAX_DEPTH = 64;
const MAX_TREE_NODES = 20_000;
const whitespace = (ch: string | undefined) => ch === undefined || /\s/u.test(ch);
const punctuation = (ch: string | undefined) => ch !== undefined && /[\p{P}\p{S}]/u.test(ch);

/** Linear, conservative preflight before any Markdown parser/plugin runs.
 * CommonMark/GFM parsers can recursively visit containers while constructing
 * their initial tree, before a remark transformer gets to inspect it. Fence
 * bodies are literal code, so large snippets must not spend inline budgets. */
export function markdownWithinBudget(text: string): boolean {
  let fence: { marker: string; length: number } | null = null;
  let brackets = 0;
  const delimiters: Array<{ marker: string; length: number }> = [];
  let delimiterDepth = 0;
  for (const line of text.split("\n")) {
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenceLine && fenceLine[1][0] === fence.marker && fenceLine[1].length >= fence.length && !fenceLine[2].trim()) fence = null;
      continue;
    }
    if (fenceLine && (fenceLine[1][0] !== "`" || !fenceLine[2].includes("`"))) {
      fence = { marker: fenceLine[1][0], length: fenceLine[1].length };
      brackets = 0;
      delimiters.length = 0;
      delimiterDepth = 0;
      continue;
    }
    if (!line.trim()) { brackets = 0; delimiters.length = 0; delimiterDepth = 0; continue; }
    // Guard deeply indented lists as well as many quote/list containers on
    // one line. We deliberately fall back instead of guessing a huge prefix
    // is an indented code block; an existing list can change its meaning.
    let prefix = 0;
    let containers = 0;
    while (prefix < line.length) {
      let indentation = 0;
      while (line[prefix] === " " || line[prefix] === "\t") {
        indentation += line[prefix++] === "\t" ? 4 : 1;
        if (indentation > MAX_DEPTH * 4) return false;
      }
      const marker = /^(?:>|[-+*](?=\s)|\d{1,9}[.)](?=\s))/.exec(line.slice(prefix));
      if (!marker) break;
      if (++containers > MAX_DEPTH) return false;
      prefix += marker[0].length;
    }
    for (let index = 0; index < line.length; index++) {
      const ch = line[index];
      if (ch === "\\") { index += 1; continue; }
      if (ch === "[" && ++brackets > MAX_DEPTH) return false;
      if (ch === "]") brackets = Math.max(0, brackets - 1);
      if (ch === "*" || ch === "_" || ch === "~") {
        const start = index;
        while (line[index + 1] === ch) index += 1;
        let length = index - start + 1;
        const before = line[start - 1];
        const after = line[index + 1];
        const left = !whitespace(after) && (!punctuation(after) || whitespace(before) || punctuation(before));
        const right = !whitespace(before) && (!punctuation(before) || whitespace(after) || punctuation(after));
        const canOpen = left && (ch !== "_" || !right || punctuation(before));
        const canClose = right && (ch !== "_" || !left || punctuation(after));
        // An upper-bound delimiter stack, not another Markdown parser. Match
        // closing runs so wide, shallow lists/ordinary repeated emphasis do
        // not use the depth allowance merely by being long.
        if (canClose) {
          let previous = delimiters.length - 1;
          while (previous >= 0 && delimiters[previous].marker !== ch) previous -= 1;
          if (previous >= 0) {
            const opening = delimiters[previous];
            delimiterDepth -= Math.ceil(opening.length / 2);
            if (length >= opening.length) {
              length -= opening.length;
              delimiters.splice(previous, 1);
            } else {
              opening.length -= length;
              length = 0;
              delimiterDepth += Math.ceil(opening.length / 2);
            }
          }
        }
        if (length && canOpen) {
          delimiters.push({ marker: ch, length });
          delimiterDepth += Math.ceil(length / 2);
          if (delimiterDepth > MAX_DEPTH) return false;
        }
      }
    }
  }
  return true;
}

/** Independent iterative guard before remark/rehype render traversals. The
 * parser preflight is conservative, not a second Markdown implementation. */
export function remarkBoundedTree() {
  return (tree: unknown) => {
    const pending: Array<{ node: unknown; depth: number }> = [{ node: tree, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (++nodes > MAX_TREE_NODES || depth > MAX_DEPTH) throw new Error("Markdown structure exceeds browser budget");
      if (!node || typeof node !== "object") continue;
      const children = (node as { children?: unknown }).children;
      if (!Array.isArray(children)) continue;
      if (nodes + pending.length + children.length > MAX_TREE_NODES) throw new Error("Markdown structure exceeds browser budget");
      for (const child of children) pending.push({ node: child, depth: depth + 1 });
    }
  };
}
