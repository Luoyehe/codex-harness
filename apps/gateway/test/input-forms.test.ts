import { expect, it } from "vitest";
import { inputForm, validateInput, validateResponse } from "../../../shared/input-forms.mjs";

const request = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ method: "mcpServer/elicitation/request" as const, params: { mode: "form", requestedSchema: { type: "object", properties, required } } });
const accept = (content: unknown) => ({ action: "accept", content, _meta: null });

it("validates all flat primitive fields, titled/legacy/multi enums, and exact numeric bounds", () => {
  const formRequest = request({
    number: { type: "number", minimum: 0.5, maximum: 3 }, integer: { type: "integer", minimum: 1 }, yes: { type: "boolean" },
    title: { type: "string", oneOf: [{ const: "a", title: "A" }] }, legacy: { type: "string", enum: ["a"], enumNames: ["A"] },
    multi: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] } },
  });
  const content = { number: 0.5, integer: 1, yes: false, title: "a", legacy: "a", multi: ["a", "b"] };
  expect(inputForm(formRequest).error).toBeUndefined();
  expect(validateResponse(formRequest, accept(content))).toEqual({});
  for (const patch of [{ number: "0.5" }, { number: 0.4 }, { integer: 1.5 }, { yes: "true" }, { title: "b" }, { multi: ["a", "a"] }, { multi: [] }, { unknown: true }]) {
    expect(validateResponse(formRequest, accept({ ...content, ...patch })).error).toBeTruthy();
  }
  expect(validateInput(inputForm(request({ n: { type: "number" } })), { n: "1.2" }).content).toEqual({ n: 1.2 });
  for (const value of [null, [], false, " "]) expect(validateInput(inputForm(request({ n: { type: "number" } })), { n: value }).error).toBeTruthy();
});

it.each([
  { type: "string", minLength: -1 }, { type: "array", items: { type: "string", enum: ["a"], pattern: "evil" } },
  { type: "array", items: { anyOf: [{ const: "a", title: "A", pattern: "evil" }] } },
  { type: "string", enum: ["a"], oneOf: [{ const: "b" }] }, { type: "number", maxLength: 2 },
  { type: "boolean", minimum: 0 }, { type: "integer", minimum: 2, maximum: 1 }, { type: "string", minLength: 1.5 },
  { type: "string", enum: ["a", "a"] }, { type: "string", enum: ["a"], enumNames: [] },
  { type: "string", default: 1 }, { type: "string", format: "unknown" }, { type: "object", properties: {} },
])("fails closed on unsupported or malformed schema %#", (field) => {
  const formRequest = request({ field });
  expect(inputForm(formRequest).error).toBeTruthy();
  expect(validateResponse(formRequest, accept({ field: "a" })).error).toBeTruthy();
  expect(validateResponse(formRequest, { action: "cancel", content: null, _meta: null })).toEqual({});
});

it("validates date/calendar and string-codepoint limits without echoing entered secrets", () => {
  const formRequest = request({ secret: { type: "string", writeOnly: true, default: "do-not-prefill", minLength: 2, maxLength: 3 }, date: { type: "string", format: "date-time" } });
  expect(inputForm(formRequest).fields[0].defaultValue).toBeUndefined();
  expect(validateResponse(formRequest, accept({ secret: "🙂🙂", date: "2024-02-29T12:00:00Z" }))).toEqual({});
  expect(validateResponse(formRequest, accept({ secret: "example", date: "2024-02-29T12:00:00Z" })).error).not.toContain("example");
  expect(validateResponse(formRequest, accept({ secret: "ok", date: "2025-02-29T12:00:00Z" })).error).toBeTruthy();
});

it("validates question IDs, one answer, option membership, free text and bounded secret input", () => {
  const tool = { method: "item/tool/requestUserInput" as const, params: { questions: [
    { id: "q", header: "Q", question: "Choose", isOther: false, isSecret: false, options: [{ label: "yes", description: "" }] },
    { id: "key", header: "Secret", question: "Key", isOther: false, isSecret: true, options: null },
  ] } };
  const answers = { q: { answers: ["yes"] }, key: { answers: ["private-value"] } };
  expect(validateResponse(tool, { answers })).toEqual({});
  for (const value of [{ answers: { q: answers.q } }, { answers: { ...answers, extra: answers.q } }, { answers: { ...answers, q: { answers: ["yes", "no"] } } }, { answers: { ...answers, q: { answers: ["no"] } } }, { answers: { ...answers, key: { answers: ["x".repeat(20001)] } } }]) expect(validateResponse(tool, value).error).toBeTruthy();
  expect(validateResponse(tool, { answers: {} })).toEqual({});
  tool.params.questions[0].isOther = true;
  expect(validateResponse(tool, { answers: { ...answers, q: { answers: ["custom"] } } })).toEqual({});
});
