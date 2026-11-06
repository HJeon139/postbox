import { createServer } from 'node:http';
import { checkToken } from './auth.mjs';
import { route } from './router.mjs';

const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    if (req.method !== 'GET' && !checkToken(req)) return send(res, 401, { error: 'A token is needed to change the pantry.' });
    const { status, body } = await route(req);
    send(res, status, body);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Something went wrong.' });
  } finally {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
  }
});

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

server.listen(8080);
