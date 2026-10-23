// A large app goes by file, not by side channel (#54): show_app and update_app read codePath and data files from the
// agent’s own folders, under the same limits, and /mcp runs tool calls only from a turn Postbox started.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Blobs } from '../server/blobs.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { Runtime, readCapped } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { LIMITS } from '../shared/limits.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An adapter that works in a folder, and runs each turn’s step with its context. */
class InFolder {
  name = 'mock';
  constructor(folder) {
    this.folder = folder;
    this.next = [];
  }
  async folderFor() {
    return this.folder;
  }
  async deliver(_se, _m, ctx) {
    await (this.next.shift() ?? (async () => {}))(ctx);
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pb-app-files-'));
  const folder = join(root, 'work');
  const outside = join(root, 'outside');
  await mkdir(folder);
  await mkdir(outside);
  const store = new Store(null);
  const adapter = new InFolder(folder);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    blobs: new Blobs(join(root, 'blobs')),
  });
  store.emit('project', { id: 'p1', name: 'P', folder: null });
  const a = rt.createPersona({ handle: 'alpha' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const se = rt.sessionsIn(t.id)[0];
  /** Calls a tool over MCP from inside a turn, with that turn’s token. */
  const call = async (name, args) => {
    let out = null;
    adapter.next.push(async (c) => {
      out = await handleMcp(
        rt,
        se.id,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        new URL(c.mcpUrl).searchParams.get('turn'),
      );
    });
    rt.sendMessage(t.id, { text: 'go' });
    for (let i = 0; i < 100 && (out === null || rt.turns.size); i++) await sleep(5);
    return { text: out.result?.content?.[0]?.text ?? out.error?.message, isError: out.result?.isError ?? true };
  };
  return { rt, store, t, se, folder, outside, call };
}

test('#54: show_app reads its code from codePath in the agent’s folder, and update_app too', async () => {
  const { rt, folder, call } = await setup();
  await writeFile(join(folder, 'app.html'), '<p>v1 from a file</p>');
  const r = await call('show_app', { id: 'big', title: 'Big', codePath: 'app.html' });
  assert.equal(r.isError, false, r.text);
  assert.equal(rt.s.apps.big.versions[0].code, '<p>v1 from a file</p>');
  await writeFile(join(folder, 'v2.html'), '<p>v2</p>');
  assert.equal((await call('update_app', { id: 'big', codePath: join(folder, 'v2.html'), summary: 'v2' })).isError, false);
  assert.equal(rt.s.apps.big.versions[1].code, '<p>v2</p>');
  // Inline code still works, and both at once is refused.
  assert.equal((await call('update_app', { id: 'big', code: '<p>v3</p>' })).isError, false);
  const both = await call('update_app', { id: 'big', code: '<p>x</p>', codePath: 'app.html' });
  assert.equal(both.isError, true);
  assert.match(both.text, /code or codePath, not both/);
  assert.equal(rt.s.apps.big.versions.length, 3);
});

test('#54: codePath can’t leave the agent’s folders, by path or by link, and keeps the code limit', async () => {
  const { rt, folder, outside, call } = await setup();
  await writeFile(join(outside, 'secret.html'), '<p>not yours</p>');
  await symlink(join(outside, 'secret.html'), join(folder, 'link.html'));
  for (const codePath of ['../outside/secret.html', join(outside, 'secret.html'), 'link.html']) {
    const r = await call('show_app', { id: 'x', title: 'X', codePath });
    assert.equal(r.isError, true, codePath);
    assert.match(r.text, /outside your folders/, codePath);
  }
  assert.match((await call('show_app', { id: 'x', title: 'X', codePath: 'missing.html' })).text, /no file at missing\.html/);
  await writeFile(join(folder, 'huge.html'), 'x'.repeat(LIMITS.appCode + 1));
  assert.match((await call('show_app', { id: 'x', title: 'X', codePath: 'huge.html' })).text, /up to 600,000/);
  assert.equal(rt.s.apps.x, undefined, 'nothing was shown');
});

test('#54: data files are stored with the version, read back by name, and carried to the next version', async () => {
  const { rt, folder, call } = await setup();
  await writeFile(join(folder, 'pairs.json'), JSON.stringify([{ claim: 1 }, { claim: 2 }]));
  await writeFile(join(folder, 'notes.txt'), 'hello');
  const r = await call('show_app', { id: 'ex', title: 'Explorer', code: '<p>x</p>', files: [{ path: 'pairs.json' }, { name: 'readme', path: 'notes.txt' }] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(
    rt.s.apps.ex.versions[0].files.map((f) => [f.name, f.size]),
    [
      ['pairs.json', 25],
      ['readme', 5],
    ],
  );
  assert.equal((await rt.appFile('ex', 'pairs.json')).toString(), '[{"claim":1},{"claim":2}]');
  // The file was copied when it was shown: changing it later doesn’t change the app.
  await writeFile(join(folder, 'notes.txt'), 'changed');
  assert.equal((await rt.appFile('ex', 'readme')).toString(), 'hello');
  await assert.rejects(() => rt.appFile('ex', 'nope'), /has no file “nope”/);
  // A version without files keeps the last one’s; one with files replaces them, and older versions keep theirs.
  await call('update_app', { id: 'ex', code: '<p>2</p>' });
  assert.deepEqual(
    rt.s.apps.ex.versions[1].files.map((f) => f.name),
    ['pairs.json', 'readme'],
  );
  await call('update_app', { id: 'ex', code: '<p>3</p>', files: [{ name: 'readme', path: 'notes.txt' }] });
  assert.equal((await rt.appFile('ex', 'readme')).toString(), 'changed');
  assert.equal((await rt.appFile('ex', 'readme', 1)).toString(), 'hello');
  await assert.rejects(() => rt.appFile('ex', 'pairs.json'), /no file/);
});

test('#54: a call can’t attach a file Postbox stored for someone else, or more files than the limit', async () => {
  const { rt, folder, call } = await setup();
  const { sha256 } = await rt.blobs.put(Buffer.from('the person’s upload'));
  const r = await call('show_app', { id: 'ex', title: 'E', code: '<p>x</p>', files: [{ name: 'stolen', sha256, size: 19 }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /needs a path/);
  await writeFile(join(folder, 'a.txt'), 'a');
  const many = Array.from({ length: LIMITS.appFiles + 1 }, (_, i) => ({ name: `f${i}`, path: 'a.txt' }));
  assert.match((await call('show_app', { id: 'ex', title: 'E', code: '<p>x</p>', files: many })).text, /up to 8 data files/);
  assert.match((await call('show_app', { id: 'ex', title: 'E', code: '<p>x</p>', files: [{ name: '../x', path: 'a.txt' }] })).text, /can’t name a file/);
  assert.equal(rt.s.apps.ex, undefined);
});

test('#54: a read stops one byte past its limit, so a file that grew after its size was checked is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-capped-'));
  const f = join(dir, 'f');
  await writeFile(f, 'x'.repeat(10));
  assert.equal(await readCapped(f, 9), null);
  assert.equal((await readCapped(f, 10)).toString(), 'x'.repeat(10));
  // Past one chunk, too.
  await writeFile(f, 'y'.repeat(2 * 1024 * 1024 + 5));
  assert.equal(await readCapped(f, 2 * 1024 * 1024 + 4), null);
  assert.equal((await readCapped(f, 3 * 1024 * 1024)).length, 2 * 1024 * 1024 + 5);
});
