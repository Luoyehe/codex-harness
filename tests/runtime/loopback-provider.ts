import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
/** Deterministic local Responses substitute; it never forwards model requests. */
export async function loopbackProvider(reply = 'Local protocol fixture response.') {
  let calls = 0; const inputs: unknown[] = [];
  const server = createServer((req, res) => { void (async () => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
    let bytes = 0; const chunks: Buffer[] = []; for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024 || calls >= 16) throw new Error('Fixture input exceeds budget'); chunks.push(Buffer.from(chunk)); } inputs.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const id = ++calls; const item = { id: `message_${id}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: reply, annotations: [], logprobs: [] }] };
    const response = { id: `response_${id}`, object: 'response', created_at: 1, status: 'completed', model: 'harness-loopback-fixture', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const [index, event] of events.entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`); res.end();
  })().catch(() => res.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls: () => calls, inputs: () => inputs, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
