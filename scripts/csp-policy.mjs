import assert from "node:assert/strict";

export function assertLocalMediaCsp(value) {
  assert.ok(value, "SPA response is missing Content-Security-Policy");
  const directives = new Map();
  for (const raw of value.split(";")) {
    const [rawName, ...sources] = raw.trim().split(/\s+/);
    if (!rawName) continue;
    // CSP directive names are ASCII case-insensitive. Normalizing before the
    // duplicate check prevents a second differently-cased directive from
    // hiding the browser's effective first directive from this verifier.
    const name = rawName.toLowerCase();
    assert.ok(!directives.has(name), `duplicate CSP directive: ${name}`);
    directives.set(name, sources);
  }
  for (const name of ["img-src", "media-src"]) {
    assert.deepEqual(directives.get(name), ["'self'", "data:", "blob:"], `${name} must not permit automatic remote fetches`);
  }
}
