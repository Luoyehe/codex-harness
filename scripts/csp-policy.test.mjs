import assert from "node:assert/strict";
import test from "node:test";
import { assertLocalMediaCsp } from "./csp-policy.mjs";

test("media CSP accepts only local, data and blob sources", () => {
  assert.doesNotThrow(() => assertLocalMediaCsp("default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:"));
  for (const policy of [
    "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' data: blob:",
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; MEDIA-SRC https:",
    "default-src 'self'; IMG-SRC https:; img-src 'self' data: blob:; media-src 'self' data: blob:",
  ]) assert.throws(() => assertLocalMediaCsp(policy));
});
