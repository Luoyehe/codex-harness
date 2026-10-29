// Visual QA fixture only. No worker, shell, model, credentials or real project access.
// Run manually after build:web. This bounded process exits after 15 minutes.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
const root = resolve(import.meta.dirname, '../dist');
const project = { id: 'visual-project', name: '设计工作室', path: '/visual-fixture/design-studio' };
const thread = { id: 'visual-thread', name: '梳理产品体验与下一步计划', cwd: project.path, status: { type: 'idle' }, updatedAt: 1792857600 };
const turns = [{ id: 'visual-turn', status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: '请帮我梳理这个项目的结构，并提出下一步的设计建议。' }] }, { id: 'tool', type: 'commandExecution', command: 'rg --files', status: 'completed', aggregatedOutput: 'src/app.tsx\nsrc/styles.css\nREADME.md', exitCode: 0 }, { id: 'agent', type: 'agentMessage', text: '项目的核心结构已经梳理清楚。\n\n我建议从三个方向开始：\n\n1. **明确主流程**：让用户从项目快速进入正在处理的会话。\n2. **减少视觉干扰**：把工具详情折叠，让结果更容易阅读。\n3. **照顾每一种屏幕**：在小屏幕上保留完整操作路径。\n\n这是独立的视觉测试数据，不代表真实模型输出。' }] }];
const prompts = [{ promptId: 'visual-prompt', epoch: 'visual-fixture', threadId: thread.id, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'direction', header: '下一步方向', question: '先完善哪一部分体验？', isOther: true, isSecret: false, options: [{ label: '项目导航', description: '让用户更快开始' }, { label: '会话阅读', description: '清晰展示结果' }] }] } }];
const defaults = { model: 'visual-model', reasoningEffort: 'medium', approvalPolicy: 'on-request', sandbox: 'workspace-write' };
// An explicit read allowlist: no fixture route resumes work or accepts mutations.
const data = {
  'project/list': { data: [project] },
  'thread/list': { data: [thread], nextCursor: null },
  'thread/session': { requiresResume: false, thread, ...defaults },
  'thread/read': { thread },
  'thread/history': { turns, timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null, legacy: false },
  'model/list': { data: [{ id: 'visual-model', model: 'visual-model', displayName: '视觉测试模型', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: null },
  'collaborationMode/list': { data: [
    { name: '执行', mode: 'default', model: 'visual-model', reasoning_effort: 'medium' },
    { name: '计划', mode: 'plan', model: 'visual-model', reasoning_effort: 'medium' },
  ] },
  'environment/list': { data: [] },
  'defaults/read': defaults,
  'prompt/list': { prompts, epoch: 'visual-fixture' },
  'system/provider/read': { revision: 'visual', kind: 'chatgpt', hasApiKey: false },
  'account/read': { account: null },
  'account/rateLimits': {},
  'mcp/list': { data: [], nextCursor: null },
  'system/status': { mode: 'visual-fixture', connected: false },
  'system/logs': { text: '视觉测试 fixture，没有生产服务。' },
};
const failure = (code, message) => ({ ok: false, error: { code, message, delivery: 'not_sent' } });
function reply(res, data, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
async function handle(req, res) {
  if (req.url === '/api/session' && req.method === 'GET')
    return reply(res, { authenticated: true, operationRecoveryProtocol: 2, csrf: 'visual-fixture-only' });
  if (req.url === '/api/rpc' && req.method === 'POST') {
    const chunks = [];
    let bytes = 0;
    // destroyOnReturn:false permits a bounded 413 response before closing the request.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > 100000) {
        res.setHeader('Connection', 'close');
        reply(res, failure('fixture_limit', 'Fixture request exceeds 100000 bytes.'), 413);
        return;
      }
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return reply(res, failure('fixture_invalid_request', 'Expected an RPC JSON object.'), 400); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.method !== 'string' || !value.method)
      return reply(res, failure('fixture_invalid_request', 'Expected an RPC method string.'), 400);
    return Object.hasOwn(data, value.method)
      ? reply(res, { ok: true, result: data[value.method] })
      : reply(res, failure('fixture_readonly', '视觉测试模式：不执行变更。'));
  }
  if (req.url?.startsWith('/api/'))
    return reply(res, failure('fixture_readonly', '视觉测试模式：不执行变更。'), 405);
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return reply(res, failure('fixture_readonly', 'Only static reads are supported.'), 405);
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + '/') && !file.startsWith(root + '\\')) throw new Error();
    const bytes = await readFile(file);
    if (res.destroyed || res.writableEnded) return;
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime }); res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch {
    if (!res.destroyed && !res.writableEnded) { res.writeHead(404); res.end('Not found'); }
  }
}

/** Importing this fixture does not listen, install signal handlers or start timers. */
export async function startPreviewServer({ port = 5099, lifetimeMs = 15 * 60 * 1000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 15 * 60 * 1000)
    throw new Error('Invalid fixture port or lifetime.');
  const connections = new Set();
  const server = http.createServer((req, res) => {
    // EventEmitter does not await promises returned by an async request listener.
    void handle(req, res).catch(() => {
      if (req.destroyed || res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      reply(res, failure('fixture_invalid_request', 'Unable to read the fixture request.'), 400);
    });
  });
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  const sockets = new WebSocketServer({ server, path: '/api/events' });
  sockets.on('connection', socket => {
    socket.on('error', () => socket.terminate());
    socket.send(JSON.stringify({ type: 'state', data: { epoch: 'visual-fixture', connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } }));
  });
  let timer, closing;
  const close = () => {
    if (closing) return closing;
    clearTimeout(timer);
    closing = Promise.all([
      new Promise(done => sockets.close(done)),
      new Promise(done => server.close(done)),
    ]).then(() => {});
    // The fixture owns these sockets; do not wait on slow uploads or WS handshakes.
    for (const socket of sockets.clients) socket.terminate();
    for (const socket of connections) socket.destroy();
    return closing;
  };
  // ws forwards HTTP listen errors before the server's listen rejection handler.
  sockets.on('error', () => void close());
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); done(); });
    });
  } catch (error) { await close(); throw error; }
  timer = setTimeout(() => void close(), lifetimeMs); timer.unref();
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const fixture = await startPreviewServer();
    const shutdown = () => void fixture.close();
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    process.stdout.write(`Visual QA fixture only: ${fixture.url}\n`);
  } catch (error) { process.stderr.write(`Unable to start visual QA fixture: ${error.message}\n`); process.exitCode = 1; }
}
