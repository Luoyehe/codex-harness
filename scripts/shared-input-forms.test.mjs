import assert from "node:assert/strict";
import test from "node:test";
import { inputForm, validateInput, validateResponse } from "../shared/input-forms.mjs";

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

const inputCases = [
  {
    method: "item/tool/requestUserInput",
    request: (id) => ({ method: "item/tool/requestUserInput", params: { questions: [
      { id, header: "Q", question: "Q", isOther: true, isSecret: false, options: [{ label: "yes", description: "" }] },
    ] } }),
    answer: (id, value) => ({ answers: { [id]: { answers: [value] } } }),
  },
  {
    method: "mcpServer/elicitation/request",
    request: (id) => ({ method: "mcpServer/elicitation/request", params: { mode: "form", requestedSchema: {
      type: "object", properties: { [id]: { type: "string" } }, required: [id],
    } } }),
    answer: (id, value) => ({ action: "accept", content: { [id]: value }, _meta: null }),
  },
];
for (const { method, request, answer } of inputCases) {
  test(method + " rejects lone surrogates in response keys and values", () => {
    for (const invalid of ["\uD800", "\uDC00", "private-\uD800-end", "\uDC00\uD800"]) {
      for (const [id, value] of [["q", invalid], [invalid, "yes"]]) {
        const prompt = request(id);
        const checked = validateResponse(prompt, answer(id, value));
        assert.ok(checked.error);
        assert.ok(!checked.error.includes(invalid));
        assert.match(validateInput(inputForm(prompt), { [id]: value }).error, /Unicode/);
      }
    }
  });
  test(method + " preserves valid emoji and literal Unicode escape text in keys and values", () => {
    for (const value of ["📁中文🙂", "\\ud800", "\\uDC00", "\\ud83d\\udcc1"]) {
      const prompt = request(value);
      const payload = answer(value, value);
      const before = JSON.stringify(payload);
      assert.deepEqual(validateResponse(prompt, payload), {});
      assert.equal(validateInput(inputForm(prompt), { [value]: value }).content[value], value);
      assert.equal(JSON.stringify(payload), before);
    }
  });
}

test("Unicode validation preserves cancellation and valid empty input semantics", () => {
  assert.deepEqual(validateResponse(inputCases[0].request("\uD800"), { answers: {} }), {});
  for (const action of ["decline", "cancel"]) {
    assert.deepEqual(validateResponse(inputCases[1].request("\uD800"), { action, content: null, _meta: null }), {});
  }
  const prompt = inputCases[1].request("q");
  assert.deepEqual(validateResponse(prompt, inputCases[1].answer("q", "")), {});
  prompt.params.requestedSchema.required = [];
  assert.deepEqual(validateResponse(prompt, { action: "accept", content: {} }), {});
  prompt.params.requestedSchema.properties.q = { type: "array", items: { type: "string", enum: ["\uD800"] } };
  assert.match(validateInput(inputForm(prompt), { q: ["\uD800"] }).error, /Unicode/);
  assert.ok(validateResponse(prompt, { action: "accept", content: { q: ["\uD800"] } }).error);
  assert.deepEqual(validateResponse(prompt, { action: "accept", content: { q: [] } }), {});
});
