// The wake chain’s loop guard (#1623; designs/intent.md, principle 6), in a real Postbox. POSTBOX_CHAIN_LIMIT (#508)
// sets the cap of agent wakes in a row without the person, 1,000 unless set. Two mock agents that ask each other to
// check “in a loop” (server/adapters/mock.mjs, @indexer and @researcher) stop at the cap: the room shows one line, and
// there’s no card, no need and no notification. With a value that isn’t a whole number from 1 to 10,000, Postbox refuses
// to start. Each case is a process of its own, since shared/limits.mjs reads the variable once, when it loads.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pb-chain-limit-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a module script in a Node process at ROOT, with POSTBOX_CHAIN_LIMIT set or not. */
function node(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: dir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** A port nothing listens on now, for the Postbox a script starts. */
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {any} */ (s.address());
      s.close(() => resolve(port));
    });
  });

// A Postbox listening on its port, with the mock backend: the person asks @indexer, over HTTP with the page’s token, to
// check with @researcher in a loop, and the script waits until no turn runs. What the room holds then, as a line of JSON.
const LOOP = `
import { start } from './server/index.mjs';
import { HOP_LIMIT } from './shared/limits.mjs';
const { LOOP_PORT: port, LOOP_DATA: data } = process.env;
const app = await start({ port: Number(port), dataDir: data, fresh: true, quiet: true, claudeHome: data });
const { rt, store } = app;
store.emit('project', { id: 'p1', name: 'Loop', folder: data });
// The mock agents a fresh Postbox starts with, or new ones of the same handles.
const ids = ['indexer', 'researcher'].map((handle) => (rt.personas.byHandle(handle) ?? rt.createPersona({ handle, backend: 'mock', permissionMode: 'auto', tools: [] })).id);
const t = rt.createThread({ projectId: 'p1', title: 'Loop', personaIds: ids });
const origin = 'http://127.0.0.1:' + port;
const page = await fetch(origin + '/', { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' } });
const cookie = page.headers.get('set-cookie').split(';')[0];
const notified = [];
// A turn that ends says so (level info); what asks for the person is any other.
store.subscribe((ev) => ev.type === 'notify' && ev.data.level !== 'info' && notified.push(ev.data));
const sent = await fetch(origin + '/api/threads/' + t.id + '/messages', {
  method: 'POST',
  headers: { cookie, origin, 'content-type': 'application/json' },
  body: JSON.stringify({ text: '@indexer ping researcher in a loop' }),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let quiet = 0, i = 0; quiet < 10 && i < 600; i++) {
  await sleep(50);
  quiet = rt.turns.size ? 0 : quiet + 1;
}
const items = store.items(t.id);
const sessions = Object.values(store.state.sessions).filter((s) => s.threadId === t.id);
console.log(JSON.stringify({
  HOP_LIMIT,
  sent: sent.status,
  lines: items.filter((x) => x.kind === 'system' && x.variant === 'chain-stopped').map((x) => x.wakes),
  cards: items.filter((x) => x.kind === 'hop').length,
  needs: sessions.filter((s) => s.needs || s.state === 'needs').map((s) => s.handle),
  notified,
  turns: items.filter((x) => x.kind === 'agent' && x.handle).map((x) => x.handle),
}));
await app.close();
process.exit(0);
`;

test('#1623 under POSTBOX_CHAIN_LIMIT=3 two agents that loop stop at the cap: one line in the room, no card, no need, nothing that asks for the person', async () => {
  const env = { LOOP_PORT: String(await freePort()), LOOP_DATA: join(dir, 'loop-3'), POSTBOX_CHAIN_LIMIT: '3', POSTBOX_BACKENDS: 'mock' };
  const r = await node(['--input-type=module', '-e', LOOP], env);
  assert.equal(r.code, 0, r.err);
  const got = JSON.parse(r.out.trim().split('\n').at(-1));
  assert.equal(got.sent, 201);
  assert.equal(got.HOP_LIMIT, 3);
  assert.deepEqual(got.lines, [3], `one line, naming the cap it stopped at: ${JSON.stringify(got)}`);
  assert.equal(got.cards, 0, 'no card');
  assert.deepEqual(got.needs, [], 'no one needs the person');
  assert.deepEqual(got.notified, [], 'no notification that asks for the person');
  assert.ok(got.turns.length >= 4 && got.turns.length <= 5, `the person’s turn, three wakes and the one the cap stopped: ${got.turns}`);
});

const LIMIT = "import { HOP_LIMIT } from './shared/limits.mjs'; console.log(HOP_LIMIT);";

test('without the variable the cap is 1,000', async () => {
  const r = await node(['--input-type=module', '-e', LIMIT], {});
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), '1000');
});

test('POSTBOX_CHAIN_LIMIT can set the cap as high as 10,000, but no higher', async () => {
  for (const limit of ['1000', '10000']) {
    const r = await node(['--input-type=module', '-e', LIMIT], { POSTBOX_CHAIN_LIMIT: limit });
    assert.equal(r.code, 0, `${limit}: ${r.err}`);
    assert.equal(r.out.trim(), limit);
  }
  const r = await node([join(ROOT, 'server', 'index.mjs'), '--port', '0', '--data', join(dir, 'data-high'), '--fresh'], {
    POSTBOX_CHAIN_LIMIT: '10001',
    POSTBOX_BACKENDS: 'mock',
  });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /POSTBOX_CHAIN_LIMIT takes a whole number from 1 to 10,000, not “10001”/);
});

test('a Postbox started with a bad POSTBOX_CHAIN_LIMIT refuses to start, and says what it takes', async () => {
  const r = await node([join(ROOT, 'server', 'index.mjs'), '--port', '0', '--data', join(dir, 'data'), '--fresh'], {
    POSTBOX_CHAIN_LIMIT: 'abc',
    POSTBOX_BACKENDS: 'mock',
  });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /POSTBOX_CHAIN_LIMIT/);
  assert.match(r.err, /whole number from 1/);
  assert.match(r.err, /“abc”/);
});
