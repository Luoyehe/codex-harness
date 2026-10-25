import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const echo = { name: 'echo', description: 'Local deterministic echo fixture.', inputSchema: { type: 'object', properties: { message: { type: 'string' }, fail: { type: 'boolean' } }, required: ['message'], additionalProperties: false } };
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (log) appendFileSync(log, JSON.stringify({ method: request.method, pid: process.pid }) + '\n');
  if (!Object.hasOwn(request, 'id')) return;
  const params = request.params ?? {}; let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'harness-local-mcp', version: '1' } };
  else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/list') result = { tools: [echo] };
  else if (request.method === 'resources/list') result = { resources: [{ name: 'known', uri: 'fixture://known', mimeType: 'text/plain' }] };
  else if (request.method === 'resources/templates/list') result = { resourceTemplates: [{ name: 'items', uriTemplate: 'fixture://items/{id}', mimeType: 'text/plain' }] };
  else if (request.method === 'resources/read') result = { contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'Local resource: ' + params.uri }] };
  else if (request.method === 'tools/call' && params.name === 'echo') result = { content: [{ type: 'text', text: params.arguments.message }], structuredContent: { echo: params.arguments.message }, isError: params.arguments.fail === true };
  else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported local fixture method' } }); return; }
  send({ jsonrpc: '2.0', id: request.id, result });
});
