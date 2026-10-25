// Visual QA fixture only. No worker, shell, model, credentials or real project access.
// Run manually after build:web. This bounded process exits after 15 minutes.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { WebSocketServer } from 'ws';
const root = resolve(import.meta.dirname, '../dist');
const project = { id: 'visual-project', name: '设计工作室', path: '/visual-fixture/design-studio' };
const thread = { id: 'visual-thread', name: '梳理产品体验与下一步计划', cwd: project.path, status: { type: 'idle' }, updatedAt: 1792857600 };
const turns = [{ id: 'visual-turn', status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: '请帮我梳理这个项目的结构，并提出下一步的设计建议。' }] }, { id: 'tool', type: 'commandExecution', command: 'rg --files', status: 'completed', aggregatedOutput: 'src/app.tsx\nsrc/styles.css\nREADME.md', exitCode: 0 }, { id: 'agent', type: 'agentMessage', text: '项目的核心结构已经梳理清楚。\n\n我建议从三个方向开始：\n\n1. **明确主流程**：让用户从项目快速进入正在处理的会话。\n2. **减少视觉干扰**：把工具详情折叠，让结果更容易阅读。\n3. **照顾每一种屏幕**：在小屏幕上保留完整操作路径。\n\n这是独立的视觉测试数据，不代表真实模型输出。' }] }];
const prompts = [{ promptId: 'visual-prompt', epoch: 'visual-fixture', threadId: thread.id, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'direction', header: '下一步方向', question: '先完善哪一部分体验？', isOther: true, isSecret: false, options: [{ label: '项目导航', description: '让用户更快开始' }, { label: '会话阅读', description: '清晰展示结果' }] }] } }];
const reply = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/session') return reply(res, { authenticated: true, csrf: 'visual-fixture-only' });
  if (req.url === '/api/rpc') {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100000) return reply(res, { ok: false, error: { message: 'fixture limit', delivery: 'not_sent' } }, 413); }
    const { method } = JSON.parse(body);
    const data = { 'project/list': { data: [project] }, 'thread/list': { data: [thread], nextCursor: null }, 'thread/resume': { thread }, 'thread/read': { thread }, 'thread/history': { turns, timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null, legacy: false }, 'model/list': { data: [{ id: 'visual-model', model: 'visual-model', displayName: '视觉测试模型', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: null }, 'defaults/read': { model: 'visual-model', reasoningEffort: 'medium', approvalPolicy: 'on-request', sandbox: 'workspace-write' }, 'prompt/list': { prompts, epoch: 'visual-fixture' }, 'system/provider/read': { revision: 'visual', kind: 'chatgpt', hasApiKey: false }, 'account/read': { account: null }, 'account/rateLimits': {}, 'mcp/list': { data: [], nextCursor: null }, 'system/status': { mode: 'visual-fixture', connected: false }, 'system/logs': { entries: ['视觉测试 fixture，没有生产服务。'] } };
    return method in data ? reply(res, { ok: true, result: data[method] }) : reply(res, { ok: false, error: { code: 'fixture_readonly', delivery: 'not_sent', message: '视觉测试模式：不执行变更。' } });
  }
  try { const url = new URL(req.url, 'http://127.0.0.1'); const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname)); if (!file.startsWith(root + '/') && !file.startsWith(root + '\\')) throw new Error(); const bytes = await readFile(file); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream'; res.writeHead(200, { 'Content-Type': mime }); res.end(bytes); } catch { res.writeHead(404); res.end('Not found'); }
});
const sockets = new WebSocketServer({ server, path: '/api/events' });
sockets.on('connection', socket => socket.send(JSON.stringify({ type: 'state', data: { epoch: 'visual-fixture', connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } })));
const shutdown = () => { sockets.clients.forEach(s => s.close()); sockets.close(); server.close(); };
const timer = setTimeout(shutdown, 15 * 60 * 1000); timer.unref(); process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.listen(5099, '127.0.0.1', () => process.stdout.write('Visual QA fixture only: http://127.0.0.1:5099\n'));
