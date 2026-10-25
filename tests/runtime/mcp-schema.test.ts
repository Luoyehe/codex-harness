import { expect, test } from 'vitest';
import { validateMcpArguments } from '../../src/runtime/mcp-schema.js';
test('discovered MCP schemas validate local references, required fields, limits and supported dialects', async () => {
  for (const $schema of ['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft-07/schema#']) {
    const schema = { $schema, type: 'object', properties: { n: { $ref: '#/definitions/n' } }, required: ['n'], additionalProperties: false, definitions: { n: { type: 'integer', minimum: 1, maximum: 3 } } };
    await expect(validateMcpArguments(schema, { n: 2 })).resolves.toBeUndefined(); await expect(validateMcpArguments(schema, { n: 4 })).rejects.toMatchObject({ code: 'invalid_params' });
  }
  await expect(validateMcpArguments({ $ref: 'https://outside.test/schema' }, {})).rejects.toMatchObject({ code: 'unsupported_tool_schema' });
  await expect(validateMcpArguments({ $async: true }, {})).rejects.toMatchObject({ code: 'unsupported_tool_schema' });
  await expect(validateMcpArguments({ $schema: 'https://unknown.test/schema' }, {})).rejects.toMatchObject({ code: 'unsupported_tool_schema' });
});
test('untrusted schema regular expressions are terminated without blocking the runtime event loop', async () => {
  const started = Date.now(); let responsive = false; const timer = setTimeout(() => { responsive = true; }, 20);
  await expect(validateMcpArguments({ type: 'string', pattern: '^(a+)+$' }, 'a'.repeat(128) + '!')).rejects.toMatchObject({ code: 'unsupported_tool_schema' });
  clearTimeout(timer); expect(responsive).toBe(true); expect(Date.now() - started).toBeLessThan(5000);
  await expect(validateMcpArguments({ type: 'object' }, {})).resolves.toBeUndefined();
});
