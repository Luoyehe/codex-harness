type Container = { kind: "object"; state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd"; key?: string }
  | { kind: "array"; state: "valueOrEnd" | "value" | "commaOrEnd" };

/** Validate, but never retain, an oversized JSON response. Only a unique
 * top-level numeric id is returned. Every nested value is syntax-checked so a
 * malformed prefix/string cannot accidentally correlate another request.
 * Conservative depth/key/number limits fail closed; payload strings have no
 * allocation proportional to their length. The transport owns byte/time caps. */
export class OversizedResponse {
  private readonly stack: Container[] = [];
  private readonly keys = new Set<string>();
  private started = false;
  private ended = false;
  private invalid = false;
  private id: number | undefined;
  private token: "string" | "number" | "literal" | null = null;
  private keyToken = false;
  private capture = false;
  private raw = "";
  private escaped = false;
  private unicodeLeft = 0;
  private readonly special = /["\\\u0000-\u001f]/g;

  feed(text: string): boolean {
    for (let i = 0; i < text.length && !this.invalid;) {
      const char = text[i];
      if (this.token === "string") {
        if (this.unicodeLeft) {
          if (!/[0-9a-fA-F]/.test(char)) { this.invalid = true; break; }
          this.append(char); this.unicodeLeft--; i++; continue;
        }
        if (this.escaped) {
          this.escaped = false;
          if (char === "u") this.unicodeLeft = 4;
          else if (!'"\\/bfnrt'.includes(char)) { this.invalid = true; break; }
          this.append(char); i++; continue;
        }
        // Skip ordinary string contents in one scan, without copying them.
        this.special.lastIndex = i;
        const match = this.special.exec(text);
        const end = match?.index ?? text.length;
        if (this.capture) this.append(text.slice(i, Math.min(end, i + 1025)));
        if (this.invalid) break;
        i = end;
        if (i === text.length) continue;
        const next = text[i++];
        this.append(next);
        if (this.invalid) break;
        if (next === "\\") { this.escaped = true; continue; }
        if (next !== '"') { this.invalid = true; break; }
        this.token = null;
        if (this.keyToken) {
          const parent = this.stack.at(-1)! as Extract<Container, { kind: "object" }>;
          if (this.capture) {
            const key: string = JSON.parse(this.raw);
            if (this.keys.has(key) || this.keys.size >= 64) { this.invalid = true; break; }
            this.keys.add(key); parent.key = key;
          }
          parent.state = "colon";
        } else this.valueDone();
        this.raw = "";
        continue;
      }
      if (this.token) {
        if ((this.token === "number" ? /[0-9eE+.\-]/ : /[a-z]/).test(char)) {
          this.raw += char;
          if (this.raw.length > 128) this.invalid = true;
          i++; continue;
        }
        this.finishPrimitive();
        continue; // reprocess the delimiter in structural state
      }
      if (char === " " || char === "\r" || char === "\t" || char === "\n") { i++; continue; }
      if (!this.started) {
        this.started = true;
        if (char !== "{") { this.invalid = true; break; }
        this.stack.push({ kind: "object", state: "keyOrEnd" }); i++; continue;
      }
      if (this.ended) { this.invalid = true; break; }
      const parent = this.stack.at(-1)!;
      if (parent.kind === "object" && (parent.state === "keyOrEnd" || parent.state === "key")) {
        if (char === "}" && parent.state === "keyOrEnd") { this.close(); i++; continue; }
        if (char !== '"') { this.invalid = true; break; }
        this.string(true); i++; continue;
      }
      if (parent.state === "colon") {
        if (char !== ":") { this.invalid = true; break; }
        parent.state = "value"; i++; continue;
      }
      if (parent.state === "commaOrEnd") {
        if (char === (parent.kind === "object" ? "}" : "]")) { this.close(); i++; continue; }
        if (char !== ",") { this.invalid = true; break; }
        parent.state = parent.kind === "object" ? "key" : "value"; i++; continue;
      }
      if (parent.kind === "array" && parent.state === "valueOrEnd" && char === "]") { this.close(); i++; continue; }
      // This is a value. A response id must be a numeric primitive, never a
      // nested field, string, array or object that happens to contain an id.
      if (this.stack.length === 1 && parent.kind === "object" && parent.key === "id" && !/[0-9\-]/.test(char)) {
        this.invalid = true; break;
      }
      if (char === "{" || char === "[") {
        if (this.stack.length >= 128) { this.invalid = true; break; }
        this.stack.push(char === "{" ? { kind: "object", state: "keyOrEnd" } : { kind: "array", state: "valueOrEnd" });
      } else if (char === '"') this.string(false);
      else if (/[0-9\-]/.test(char)) { this.token = "number"; this.raw = char; }
      else if (/[tfn]/.test(char)) { this.token = "literal"; this.raw = char; }
      else { this.invalid = true; break; }
      i++;
    }
    return !this.invalid;
  }

  responseId(): number | undefined {
    if (this.token === "number" || this.token === "literal") this.finishPrimitive();
    if (this.invalid || !this.ended || this.token || this.keys.has("method") || this.keys.has("result") === this.keys.has("error")) return undefined;
    return this.id;
  }

  private append(value: string): void {
    if (!this.capture) return;
    this.raw += value;
    if (this.raw.length > 1024) this.invalid = true;
  }
  private string(key: boolean): void {
    this.token = "string"; this.keyToken = key;
    this.capture = key && this.stack.length === 1;
    this.raw = this.capture ? '"' : "";
  }
  private finishPrimitive(): void {
    const number = this.token === "number";
    if (number ? !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(this.raw) : !["true", "false", "null"].includes(this.raw)) {
      this.invalid = true; return;
    }
    const parent = this.stack.at(-1);
    if (number && this.stack.length === 1 && parent?.kind === "object" && parent.key === "id") {
      const id = Number(this.raw);
      if (!Number.isSafeInteger(id) || id <= 0) { this.invalid = true; return; }
      this.id = id;
    }
    this.raw = ""; this.token = null; this.valueDone();
  }
  private close(): void {
    this.stack.pop();
    if (!this.stack.length) this.ended = true;
    else this.valueDone();
  }
  private valueDone(): void {
    const parent = this.stack.at(-1);
    if (!parent) { this.invalid = true; return; }
    parent.state = "commaOrEnd";
  }
}
