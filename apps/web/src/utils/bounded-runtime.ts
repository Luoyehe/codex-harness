const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_MAX_NODES = 1_000;
const DEFAULT_MAX_DEPTH = 16;

interface ProjectionBudget {
  chars: number;
  nodes: number;
  exceeded: boolean;
  seen: WeakSet<object>;
}

function projectRuntimeValue(value: unknown, budget: ProjectionBudget, depth: number, maxChars: number, maxNodes: number, maxDepth: number): unknown {
  if (++budget.nodes > maxNodes || depth > maxDepth) {
    budget.exceeded = true;
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return String(value).slice(0, 256);
  if (typeof value === "undefined") return null;
  if (typeof value === "string") {
    const remaining = Math.max(0, maxChars - budget.chars);
    if (value.length > remaining) budget.exceeded = true;
    const bounded = value.slice(0, remaining);
    budget.chars += bounded.length;
    return bounded;
  }
  if (typeof value !== "object") return null;
  if (budget.seen.has(value)) return "[循环引用]";
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const inspected = Math.min(value.length, maxNodes - budget.nodes);
      for (let index = 0; index < inspected && !budget.exceeded; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          budget.exceeded = true;
          break;
        }
        result.push(projectRuntimeValue(descriptor.value, budget, depth + 1, maxChars, maxNodes, maxDepth));
      }
      if (inspected < value.length) budget.exceeded = true;
      return result;
    }
    const result: Record<string, unknown> = {};
    let inspected = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (++inspected > maxNodes - budget.nodes) { budget.exceeded = true; break; }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) { budget.exceeded = true; break; }
      const boundedKey = key.slice(0, 256);
      if (boundedKey !== key) budget.exceeded = true;
      result[boundedKey] = projectRuntimeValue(descriptor.value, budget, depth + 1, maxChars, maxNodes, maxDepth);
      if (budget.exceeded) break;
    }
    return result;
  } finally {
    budget.seen.delete(value);
  }
}

/** Serialize only a small, data-property projection of untrusted runtime data.
 * Accessors are never executed and oversized values fail closed instead of
 * asking JSON.stringify to materialize the full graph first. */
export function boundedRuntimeJson(value: unknown, maxChars = DEFAULT_MAX_CHARS, maxNodes = DEFAULT_MAX_NODES, maxDepth = DEFAULT_MAX_DEPTH): string {
  if (typeof value === "string") {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[内容超过浏览器显示预算]`;
  }
  const budget: ProjectionBudget = { chars: 0, nodes: 0, exceeded: false, seen: new WeakSet() };
  try {
    const projected = projectRuntimeValue(value, budget, 0, maxChars, maxNodes, maxDepth);
    if (budget.exceeded) return "（内容超过浏览器安全检查预算，未展开）";
    const serialized = JSON.stringify(projected, null, 2);
    if (typeof serialized !== "string") return "（内容格式无效）";
    return serialized.length <= maxChars ? serialized : "（内容超过浏览器显示预算，未展开）";
  } catch {
    return "（内容无法安全序列化）";
  }
}

/** Replace secrets only after bounding the source string. */
export function boundedRedact(value: unknown, secrets: readonly string[], maxChars: number): string {
  if (typeof value !== "string") return value == null ? "" : "(输出格式无效)";
  const usableSecrets: string[] = [];
  for (let index = 0; index < Math.min(secrets.length, 32); index++) {
    const secret = secrets[index];
    if (!secret) continue;
    if (secret.length > 8_192) return "(输出包含无法安全处理的超长密钥，已隐藏)";
    usableSecrets.push(secret);
  }
  if (secrets.length > 32) return "(需要隐藏的密钥数量超过浏览器预算，输出已隐藏)";
  const overlap = usableSecrets.reduce((longest, secret) => Math.max(longest, secret.length), 0);
  let text = value.slice(0, maxChars + overlap);
  for (const secret of usableSecrets) {
    if (!secret) continue;
    let cursor = 0;
    let hit = text.indexOf(secret, cursor);
    if (hit < 0) continue;
    const parts: string[] = [];
    let length = 0;
    while (hit >= 0 && length < maxChars) {
      const prefix = text.slice(cursor, hit);
      parts.push(prefix, "[REDACTED]");
      length += prefix.length + 10;
      cursor = hit + secret.length;
      hit = text.indexOf(secret, cursor);
    }
    parts.push(text.slice(cursor, Math.max(cursor, cursor + maxChars - length)));
    text = parts.join("").slice(0, maxChars + overlap);
  }
  text = text.slice(0, maxChars);
  return value.length > maxChars ? `${text}\n…（输出过长，仅检查并显示前 ${maxChars.toLocaleString()} 个字符）` : text;
}
