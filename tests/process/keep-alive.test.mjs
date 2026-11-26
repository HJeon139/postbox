// #1726: Postbox keeps an idle connection open longer than the clients that pool them do. Node’s default closes one
// idle 5 s (plus a 1 s buffer), and a client that reuses it at that moment gets ECONNRESET: Playwright’s request
// context did, on CI. An agent’s MCP client that pools connections without reading the Keep-Alive hint, as Go’s and
// Rust’s hyper do for 90 s, can hit the same race on a tool call, a POST nothing retries.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, get } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeServer, httpServer } from '../../server/http-server.mjs';
import { start } from '../../server/index.mjs';
import { tempDir } from '../temp-dirs.mjs';

/** No backend found, so the test looks for none of the real ones. */
const none = async () => null;

/** A port free now, from the system. */
async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
  probe.close();
  await once(probe, 'close');
  return port;
}

/** One GET on the agent: its status, and whether it went on a connection the agent already had. */
function fetchOn(/** @type {Agent} */ agent, /** @type {string} */ url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { agent }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, reused: req.reusedSocket }));
    });
    req.on('error', reject);
  });
}

test('#1726 a connection left idle past Node’s default 5 s (plus 1 s) still answers its next request', async (t) => {
  const dir = tempDir('pb-keep-alive-');
  const port = await freePort();
  const app = await start({
    port,
    dataDir: join(dir, 'data'),
    quiet: true,
    hosts: null,
    claudeHome: dir,
    probes: { claude: none, sdk: none, kiro: none, agy: none, codex: none },
  });
  t.after(() => app.close().catch(() => {}));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const url = `http://127.0.0.1:${port}/`;
  assert.deepEqual(await fetchOn(agent, url), { status: 200, reused: false });
  // The idle time is what this tests, so it waits it out: a pool keeps a connection this long and more.
  await new Promise((r) => setTimeout(r, 6500));
  assert.deepEqual(await fetchOn(agent, url), { status: 200, reused: true }, 'the same connection answered');
  // With that connection still open and idle, Postbox closes at once: close() ends idle connections, so the longer
  // idle time never holds up a quit.
  const t0 = Date.now();
  await app.close();
  assert.ok(Date.now() - t0 < 3000, `close took ${Date.now() - t0} ms with an idle connection open`);
});

test('#1726 a response still going when Postbox closes doesn’t hold the close for the idle time after it', async (t) => {
  /** @type {(res: import('node:http').ServerResponse) => void} */
  let asked = () => {};
  const inFlight = new Promise((r) => {
    asked = r;
  });
  const server = httpServer((_req, res) => asked(res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const agent = new Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const reply = fetchOn(agent, `http://127.0.0.1:${port}/`);
  const res = /** @type {import('node:http').ServerResponse} */ (await inFlight);
  // Close while the response is still going, then end it: the close comes about a second after that response is done.
  const closed = closeServer(server).then(() => 'closed');
  res.end('ok');
  assert.deepEqual(await reply, { status: 200, reused: false });
  const timer = new Promise((r) => setTimeout(() => r('still open after 3 s'), 3000).unref());
  assert.equal(await Promise.race([closed, timer]), 'closed');
});
