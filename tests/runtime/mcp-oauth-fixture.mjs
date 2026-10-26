import readline from 'node:readline';
let starts = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'mcpServer/oauth/login') {
    starts++;
    result = { authorizationUrl: 'http://127.0.0.1:8888/authorize?state=PRIVATE-LOCAL-STATE', loginId: `login-${starts}` };
  }
  if (request.method === 'fixture/oauth/count') result = { starts };
  if (request.method === 'fixture/oauth/complete') send({ method: 'mcpServer/oauthLogin/completed', params: { name: 'server', threadId: null, loginId: `login-${starts}`, success: true } });
  send({ id: request.id, result });
});
