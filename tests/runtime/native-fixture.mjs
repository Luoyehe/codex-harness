import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lines = readline.createInterface({ input: process.stdin });
let initialization;
const heldReplies = [];
lines.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialized' || !m.method) return;
  if (m.method === process.env.HARNESS_FIXTURE_HOLD) { writeFileSync(process.env.HARNESS_FIXTURE_PID_FILE, `${process.pid}\n`); return; }
  if (m.method === 'initialize') { initialization = m.params; send({ id: m.id, result: {} }); return; }
  if (m.method === 'fixture/initialize/read') { send({ id: m.id, result: initialization }); return; }
  if (['thread/queue/list','thread/queue/update','thread/queue/add'].includes(m.method) && m.params.threadId === 'large') {
    send({ id: m.id, result: { data: [{ input: [{ type: 'text', text: 'x'.repeat(13 * 1024 * 1024), text_elements: [] }] }], nextCursor: null } }); return;
  }
  if (['mcpServer/tool/call', 'plugin/install'].includes(m.method) && m.params.holdReply) {
    heldReplies.push({ id: m.id, method: m.method });
    return;
  }
  if (m.method === 'fixture/releaseReplies') {
    const held = heldReplies.splice(0);
    for (const request of held) send({ id: request.id, result: { late: request.method } });
    send({ id: m.id, result: { released: held.map(request => request.method) } });
    return;
  }
  if (m.method === 'hold') return;
  if (m.method === 'exit') { process.exit(7); return; }
  if (m.method === 'error') { send({ id: m.id, error: { code: -32000, message: 'fixture rejection', data: { kind: 'fixture' } } }); return; }
  if (m.method === 'fixture/error/reflect') { send({ id: m.id, error: m.params }); return; }
  if (m.method === 'malformed') { send({ id: m.id, error: null }); return; }
  if (m.method === 'prompt') { send({ id: 'original-string-id', method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'i', reason: null, grantRoot: null } }); send({ id: m.id, result: {} }); return; }
  if (m.method === 'pause') { process.stdin.pause(); lines.pause(); setInterval(() => {}, 1000); send({ id: m.id, result: {} }); return; }
  send({ id: m.id, result: m.params });
});
