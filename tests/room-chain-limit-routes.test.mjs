// #1035: only the person sets a room’s wake chain limit, through PATCH /api/threads/:id with the page’s token. It takes
// a whole number from 1 to 10,000, or null for the server’s default, and refuses anything else with a 422 that says what
// it takes, changing nothing. No MCP tool, agent route or host message sets it: an agent that could raise the cap that
// stops agents would remove the backstop (designs/intent.md, principle 6).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { updateThread } from '../server/thread-write.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { sources } from './server-sources-fixture.mjs';
import { settle, setup, sleep } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4471;
const TAKES = 'A room’s wake chain limit is a whole number from 1 to 10,000.';
let app;
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
const pageCookie = async () => (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];

before(async () => {
  const dir = tempDir('pb-room-chain-limit-routes-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  app.store.emit('project', { id: 'pr_cl', name: 'Chain', folder: dir });
});
after(() => app.close());

/** A room of two mock agents, with an agent’s message in it to open a topic thread from. */
function room(title = 'Room') {
  const personas = ['alpha', 'beta'].map((h) => Object.values(app.store.state.personas).find((p) => p.handle === h) ?? app.rt.createPersona({ handle: h }));
  const t = app.rt.createThread({ projectId: 'pr_cl', title, personaIds: personas.map((p) => p.id) });
  const [alpha] = app.rt.sessionsIn(t.id);
  const it = app.rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, personaId: alpha.personaId, handle: 'alpha', text: 'Done.', status: 'done' });
  return { t, alpha, it };
}
const threadOf = (id) => app.store.state.threads[id];

test('#1035 PATCH sets a room’s chain limit with the page’s token, and null clears it', async () => {
  const cookie = await pageCookie();
  const { t } = room();
  const set = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { chainLimit: 5 }, cookie });
  assert.equal(set.status, 200, set.text);
  assert.equal(threadOf(t.id).chainLimit, 5);
  assert.equal(threadOf(t.id).title, 'Room', 'a PATCH with no title keeps the name');
  for (const edge of [1, 10000]) {
    const r = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { chainLimit: edge }, cookie });
    assert.equal(r.status, 200, `${edge}: ${r.text}`);
    assert.equal(threadOf(t.id).chainLimit, edge);
  }
  const cleared = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { chainLimit: null }, cookie });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(threadOf(t.id).chainLimit, null);
});

test('#1035 a chain limit that isn’t a whole number from 1 to 10,000 gets a 422 that says what it takes, and changes nothing', async () => {
  const cookie = await pageCookie();
  const { t } = room();
  assert.equal((await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { chainLimit: 7 }, cookie })).status, 200);
  const before = structuredClone(threadOf(t.id));
  const bad = [{ body: { chainLimit: 0 } }, { body: { chainLimit: -1 } }, { body: { chainLimit: 2.5 } }, { body: { chainLimit: 'abc' } }];
  bad.push({ body: { chainLimit: '5' } }, { body: { chainLimit: 10001 } }, { body: { chainLimit: 'Infinity' } }, { raw: '{"chainLimit":1e400}' });
  bad.push({ body: { chainLimit: 0, title: 'Renamed' } });
  for (const r of bad) {
    const res = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, ...r, cookie });
    assert.equal(res.status, 422, `${JSON.stringify(r)}: ${res.text}`);
    assert.equal(res.json.error, TAKES);
    assert.deepEqual(threadOf(t.id), before, `${JSON.stringify(r)} changed nothing, not even the name`);
  }
});

test('#1035 renaming still works through the same PATCH, and an empty name is still refused', async () => {
  const cookie = await pageCookie();
  const { t } = room();
  const r = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { title: 'Renamed' }, cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(threadOf(t.id).title, 'Renamed');
  const empty = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { title: ' ', chainLimit: 9 }, cookie });
  assert.equal(empty.status, 422);
  assert.equal(empty.json.error, 'A conversation needs a name.');
  assert.equal(threadOf(t.id).chainLimit, undefined, 'a refused rename sets no limit either');
});

test('#1035 setting it from a topic thread saves it on the conversation, which the topic reads', async () => {
  const cookie = await pageCookie();
  const { t, it } = room();
  const { threadId: topic } = app.rt.startTopic(t.id, it.id);
  const r = await call({ method: 'PATCH', path: `/api/threads/${topic}`, body: { chainLimit: 5 }, cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(threadOf(t.id).chainLimit, 5);
  assert.equal(threadOf(topic).chainLimit, undefined, 'nothing of its own on the topic');
});

test('#1035 PATCH /api/threads/:id needs the page’s token: without it, it’s refused and the limit is unchanged', async () => {
  const { t } = room();
  const r = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { chainLimit: 10000 } });
  assert.equal(r.status, 403, r.text);
  assert.equal(threadOf(t.id).chainLimit, undefined);
});

test('#1035 no MCP tool sets or clears a room’s chain limit, whatever its arguments carry', async () => {
  // Through the MCP server’s own tools/call, from a running turn with its token, as an agent calls every tool.
  const f = setup();
  updateThread(f.rt, f.t.id, { chainLimit: 7 });
  const t = f.t.id;
  const args = { threadId: t, thread: t, id: t, itemId: t, handle: 'beta', message: 'hi', title: 'T', name: 'n', text: 'x', key: 'k' };
  const called = [];
  f.adapter.next.push(async (c) => {
    const token = new URL(c.mcpUrl).searchParams.get('turn');
    for (const { name } of TOOL_DEFS)
      for (const chainLimit of [null, 10000]) {
        const call = { jsonrpc: '2.0', id: called.length, method: 'tools/call', params: { name, arguments: { ...args, chainLimit, block: { chainLimit } } } };
        const r = await Promise.race([handleMcp(f.rt, f.alpha.id, call, token), sleep(200).then(() => ({ waited: true }))]);
        called.push([name, chainLimit, r?.error?.code ?? null]);
        assert.equal(f.store.pending.thread(t).chainLimit, 7, `${name} with chainLimit ${chainLimit}`);
      }
  });
  f.rt.sendMessage(t, { text: '@alpha go' });
  await settle(f.rt);
  assert.equal(called.length, TOOL_DEFS.length * 2, 'every tool was called, twice');
  assert.deepEqual(
    called.filter(([, , code]) => code === -32001),
    [],
    'each call ran in the turn, with its token',
  );
  assert.equal(f.store.state.threads[t].chainLimit, 7);
});

test('#1035 in server/, only room-chain-limit.mjs names a thread’s chainLimit, and only the person’s PATCH route calls its writer', () => {
  const files = sources();
  const naming = files.filter(([, text]) => /\bchainLimit\b/.test(text)).map(([path]) => path);
  assert.deepEqual(naming, ['room-chain-limit.mjs'], 'an agent-facing path that writes chainLimit would name it');
  const callers = files.filter(([path, text]) => path !== 'room-chain-limit.mjs' && /\bpatchThread\b|\bsetRoomChainLimit\b/.test(text));
  assert.deepEqual(
    callers.map(([path]) => path),
    ['index.mjs'],
  );
  const lines = callers[0][1].split('\n').filter((l) => /\bpatchThread\(|\bsetRoomChainLimit\(/.test(l));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\/\^\\\/api\\\/threads\\\/\(\[\^\/\]\+\)\$\/\)\) && req\.method === 'PATCH'/, 'the page’s PATCH /api/threads/:id, behind its token');
});
