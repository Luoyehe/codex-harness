import { expect, it } from "vitest";
import { OversizedResponse } from "../src/codex/oversized-response.js";

function scan(text: string, chunkSize = 1): number | undefined {
  const scanner = new OversizedResponse();
  for (let i = 0; i < text.length; i += chunkSize) if (!scanner.feed(text.slice(i, i + chunkSize))) return undefined;
  return scanner.responseId();
}

it.each([1, 2, 7, 128])("validates complete responses across %s-character boundaries", (size) => {
  const values = [null, true, false, 0, -1.2e-10, [], {}, [1, { nested: [null, "escaped \" } , id:2 \\ \n \t 中文 😀"] }]];
  for (const result of values) {
    expect(scan(JSON.stringify({ id: 12, result }) + "\r", size)).toBe(12);
    expect(scan(JSON.stringify({ result, id: 12 }), size)).toBe(12);
    expect(scan(JSON.stringify({ error: { message: "x", data: result }, id: 12 }), size)).toBe(12);
  }
  expect(scan('{"result":{"id":2,"text":"\\u1234 \\b \\f \\/ \\r"},"\\u0069d":12}\r', size)).toBe(12);
  expect(scan('{"id":1,"result":{"text":"fake \\"id\\":2"}}', size)).toBe(1);
});

it.each([
  '{"result":{"id":1}}', '{"id":"1","result":{}}', '{"id":null,"result":{}}',
  '{"id":1,"id":2,"result":{}}', '{"id":1,"\\u0069d":2,"result":{}}',
  '{"id":1,"result":{},"result":{}}', '{"id":1,"result":{},"error":{}}',
  '{"id":1,"method":"notification","result":{}}', '{"id":1}',
  '{"id":0,"result":{}}', '{"id":1.1,"result":{}}', '{"id":9007199254740992,"result":{}}',
  '{"id":1,"result":{"text":"bad\\q"}}', '{"id":1,"result":"bad\\u123X"}',
  '{"id":1,"result":"newline\n"}', '{"id":1,"result":truefalse}',
  '{"id":1,"result":01}', '{"id":1,"result":+1}', '{"id":1,"result":1.}',
  '{"id":1,"result":1e}', '{"id":1,"result":1e+}', '{"id":1,"result":-}',
  '{"id":1,"result":{,}}', '{"id":1,"result":[1,]}', '{"id":1,"result":{"x":1,}}',
  '{"id":1,"result":[1 2]}', '{"id":1,"result":{"x" 1}}', '{"id":1,"result":{"x":}}',
  '{"id":1,"result":{"x":1]', '{"id":1,"result":{}', '{"id":1,"result":{}} {}',
  '[{"id":1,"result":{}}]', 'null', '',
])("never correlates malformed, ambiguous or non-response JSON: %s", (text) => {
  expect(scan(text)).toBeUndefined();
  expect(scan(text, 4096)).toBeUndefined();
});

it("never correlates syntactically invalid mutations of a nested response", () => {
  const seed = JSON.stringify({ result: { rows: [null, true, false, -1.2e12, { text: 'backslash \\ quote " and 中文' }] }, id: 12 });
  const inserts = ['"', "\\", ":", ",", "}", "{", "]", "[", "0", "+", "-", "e", " ", "\t", "\r", "\0"];
  for (let i = 0; i < seed.length; i++) {
    for (const char of inserts) {
      for (const text of [seed.slice(0, i) + char + seed.slice(i), seed.slice(0, i) + char + seed.slice(i + 1)]) {
        const result = scan(text, 7);
        if (result === undefined) continue;
        // JSON.parse is an independent syntax oracle. Conservative refusals
        // are allowed; accepting malformed JSON or the wrong id is not.
        const parsed = JSON.parse(text);
        expect(result).toBe(parsed.id);
        expect(parsed).toHaveProperty("result");
        expect(parsed).not.toHaveProperty("method");
      }
    }
  }
});

it("bounds depth, key and numeric token state without retaining payload strings", () => {
  expect(scan('{"id":1,"result":' + "[".repeat(129) + "0" + "]".repeat(129) + "}", 256)).toBeUndefined();
  expect(scan('{"' + "k".repeat(2048) + '":null,"id":1,"result":{}}', 256)).toBeUndefined();
  expect(scan('{"id":1,"result":' + "1".repeat(129) + "}", 256)).toBeUndefined();
  const scanner = new OversizedResponse();
  expect(scanner.feed('{"id":1,"result":"')).toBe(true);
  for (let i = 0; i < 100; i++) expect(scanner.feed("x".repeat(65536))).toBe(true);
  expect((scanner as any).raw).toBe("");
  expect(scanner.feed('"}')).toBe(true);
  expect(scanner.responseId()).toBe(1);
});
