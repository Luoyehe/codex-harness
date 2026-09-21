import assert from "node:assert/strict";
import test from "node:test";
import { inputForm, validateResponse } from "../shared/input-forms.mjs";

for (const type of ["number", "integer", "boolean", "array", "string"]) {
  test(`single-element type arrays cannot be coerced into an unrelated ${type} input`, () => {
    const request = { method: "mcpServer/elicitation/request", params: { mode: "form", requestedSchema: {
      type: "object", properties: { value: { type: [type] } }, required: ["value"],
    } } };
    // These valid JSON Schema unions are not part of the supported flat-field
    // interpreter. Refuse acceptance rather than silently treat them as text.
    assert.ok(inputForm(request).error);
    assert.ok(validateResponse(request, { action: "accept", content: { value: "not-a-typed-value" } }).error);
    assert.deepEqual(validateResponse(request, { action: "cancel", content: null }), {});
  });
}

test("scalar types still enforce their actual response type", () => {
  const request = { method: "mcpServer/elicitation/request", params: { mode: "form", requestedSchema: {
    type: "object", properties: { value: { type: "number", minimum: 1 } }, required: ["value"],
  } } };
  assert.equal(inputForm(request).error, undefined);
  assert.deepEqual(validateResponse(request, { action: "accept", content: { value: 2 } }), {});
  assert.ok(validateResponse(request, { action: "accept", content: { value: "2" } }).error);
});
