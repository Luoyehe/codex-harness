import readline from 'node:readline';
const sessions = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!request.method || request.method === 'initialized') return;
  if (request.method === 'thread/start' || request.method === 'thread/read') {
    send({ id: request.id, result: { thread: { id: 'fixture-thread', status: { type: 'idle' }, historyMode: 'paginated', turns: [] } } }); return;
  }
  if (request.method === 'turn/start') {
    const turn = { id: 'fixture-turn', status: 'inProgress', items: [] };
    send({ method: 'turn/started', params: { threadId: 'fixture-thread', turn } }); send({ id: request.id, result: { turn } }); return;
  }
  if (request.method === 'command/exec') { sessions.set(request.params.processId, request.id); return; }
  if (request.method === 'hold') { setTimeout(() => send({ id: request.id, result: {} }), 1000); return; }
  if (request.method === 'command/exec/terminate') {
    const id = sessions.get(request.params.processId);
    if (id !== undefined) { sessions.delete(request.params.processId); send({ id, result: { exitCode: 0, stdout: '', stderr: '' } }); }
  }
  send({ id: request.id, result: {} });
});
