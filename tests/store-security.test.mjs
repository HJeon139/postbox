// The store’s Redis is private (#508’s requirements, 4.3, “Store security”). Its real server is probed in
// tests/process/redis-security.test.mjs; these check, under the guard, what the rest of Postbox can see of it.

import assert from 'node:assert/strict';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { formatMessage, turnGuide } from '../server/adapters/guide.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { RedisSupervisor } from '../server/redis-supervisor.mjs';
import { Runtime } from '../server/runtime.mjs';
import { open, raw, tmp } from './store-fixture.mjs';

test('SR-1: the store connects on its socket, and the guard lets nothing reach 127.0.0.1 while it runs', async () => {
  const s = await open(await tmp());
  const c = await raw(s);
  assert.equal(await c.call('PING'), 'PONG');
  c.close();
  for (const port of [6379, 0]) assert.throws(() => net.connect({ port, host: '127.0.0.1' }), /network connection/);
  assert.throws(() => net.connect({ path: '/tmp/some-other.sock' }), /network connection/);
});

/** A Claude Code agent whose turns the test scripts, keeping what each turn was given. */
class Scripted {
  name = 'claude-code';
  constructor(folder) {
    this.folder = folder;
    this.next = [];
    /** @type {{ guide: string, prompt: string, ctx: unknown }[]} */
    this.calls = [];
  }
  async folderFor() {
    return this.folder;
  }
  async deliver(session, message, ctx) {
    // What the real adapter sends the backend: its guide and the formatted message (server/adapters/claude-code.mjs).
    const turned = turnGuide(message, { persona: ctx.persona, session, handles: ctx.handles, room: ctx.room, project: ctx.project, brief: session?.brief });
    this.calls.push({ guide: turned.guide, prompt: formatMessage(turned.message), ctx });
    await (this.next.shift() ?? ((c) => c.text('ok')))(ctx);
  }
}

/** What an agent can read of a value: its JSON, with functions and cycles left out. */
const seen = (v) => {
  const s = new WeakSet();
  return JSON.stringify(v, (_, x) => {
    if (typeof x === 'function') return undefined;
    if (x && typeof x === 'object') {
      if (s.has(x)) return undefined;
      s.add(x);
    }
    return x;
  });
};

test('SR-7: an agent’s guide, environment and tool results never name the store’s socket or its passwords', async () => {
  const dir = await tmp();
  const folder = await tmp();
  const store = await open(dir);
  const sup = /** @type {any} */ (store).redis.sup;
  const secrets = [sup.socket, dirname(sup.socket), sup.password, sup.ownerPassword, 'redis.sock', 'owner.json'];
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(new Scripted(folder)),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: folder },
  });
  const adapter = /** @type {Scripted} */ (rt.adapters.get('claude-code'));
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'auto', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  /** @type {unknown[]} */
  const results = [];
  adapter.next.push(async (c) => {
    const token = rt.turns.get(se.id)?.token ?? null;
    const call = (method, params) => handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method, params }, token);
    results.push(await call('initialize', {}), await call('tools/list', {}));
    for (const name of ['read_conversation', 'define_term'])
      results.push(await call('tools/call', { name, arguments: name === 'define_term' ? { term: 'S', definition: 'D' } : {} }));
    c.text('done');
  });
  rt.sendMessage(t.id, { text: '@coder go' });
  for (let i = 0; i < 200 && (rt.turns.size || !adapter.calls.length); i++) await new Promise((ok) => setTimeout(ok, 10));
  await store.flush();
  assert.ok(adapter.calls.length && results.length === 4, 'the turn ran and called its tools');
  const texts = { guide: seen(adapter.calls), tools: seen(results), env: seen(process.env) };
  for (const [where, text] of Object.entries(texts))
    for (const secret of secrets)
      assert.ok(!text.includes(secret), `${where} doesn’t hold ${secret === sup.password || secret === sup.ownerPassword ? 'a password' : secret}`);
});

test('SR-7: a refused write’s reason names neither the socket nor a data path; the server log has the paths (#553)', async () => {
  // A refused write’s reason reaches an agent, in a tool result or over /mcp.
  const dir = await tmp();
  const s = await open(dir);
  const sup = /** @type {any} */ (s).redis.sup;
  const other = new RedisSupervisor({ home: sup.home, dataDir: dir });
  const logged = [];
  const { error } = console;
  console.error = (m) => logged.push(String(m));
  try {
    for (const cause of /** @type {const} */ (['socket', 'owned', 'binary-missing', 'corrupt-aof', 'died'])) {
      const { message } = other.down(cause, 'detail');
      assert.ok(!message.includes(sup.socket) && !message.includes(dirname(sup.socket)), cause);
      assert.ok(!message.includes(dir) && !message.includes(sup.home), `${cause}: ${message}`);
    }
  } finally {
    console.error = error;
  }
  assert.ok(
    logged.some((m) => m.includes(sup.home)),
    'the log names where the build was looked for',
  );
  assert.ok(
    logged.some((m) => m.includes(join(dir, 'redis', 'data'))),
    'the log names the damaged files’ folder',
  );
});
