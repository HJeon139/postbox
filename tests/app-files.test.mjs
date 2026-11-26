// A large app goes by file, not by side channel (#54): show_app and update_app read codePath and data files from the
// agent’s own folders, under the same limits, and /mcp runs tool calls only from a turn Postbox started.

import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Blobs } from '../server/blobs.mjs';
import { Runtime, readCapped } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { LIMITS } from '../shared/limits.mjs';
import * as arrange from './arrange.mjs';
import { callTool } from './review-files-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

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
  const root = tempDir('pb-app-files-');
  const folder = join(root, 'work');
  const outside = join(root, 'outside');
  await mkdir(folder);
  await mkdir(outside);
  const store = new Store(null);
  const adapter = new InFolder(folder);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    blobs: new Blobs(join(root, 'blobs')),
  });
  store.emit('project', { id: 'p1', name: 'P', folder: null });
  const a = rt.createPersona({ handle: 'alpha' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const se = arrange.agentIn(rt, t.id);
  /** Calls a tool over MCP from inside a turn, with that turn’s token. */
  const call = (name, args) => callTool(rt, adapter, t.id, se.id, name, args);
  return { rt, store, t, se, folder, outside, call };
}

test('#54: show_app reads its code from codePath in the agent’s folder, and update_app too', async () => {
  const { rt, folder, call } = await setup();
  await writeFile(join(folder, 'app.html'), '<p>v1 from a file</p>');
  const r = await call('show_app', { id: 'big', title: 'Big', codePath: 'app.html' });
  assert.equal(r.isError, false, r.text);
  assert.equal(rt.store.state.apps.big.versions[0].code, '<p>v1 from a file</p>');
  await writeFile(join(folder, 'v2.html'), '<p>v2</p>');
  assert.equal((await call('update_app', { id: 'big', codePath: join(folder, 'v2.html'), summary: 'v2' })).isError, false);
  assert.equal(rt.store.state.apps.big.versions[1].code, '<p>v2</p>');
  // Inline code still works, and both at once is refused.
  assert.equal((await call('update_app', { id: 'big', code: '<p>v3</p>' })).isError, false);
  const both = await call('update_app', { id: 'big', code: '<p>x</p>', codePath: 'app.html' });
  assert.equal(both.isError, true);
  assert.match(both.text, /code or codePath, not both/);
  assert.equal(rt.store.state.apps.big.versions.length, 3);
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
  assert.equal(rt.store.state.apps.x, undefined, 'nothing was shown');
});

test('#54: data files are stored with the version, read back by name, and carried to the next version', async () => {
  const { rt, folder, call } = await setup();
  await writeFile(join(folder, 'pairs.json'), JSON.stringify([{ claim: 1 }, { claim: 2 }]));
  await writeFile(join(folder, 'notes.txt'), 'hello');
  const r = await call('show_app', { id: 'ex', title: 'Explorer', code: '<p>x</p>', files: [{ path: 'pairs.json' }, { name: 'readme', path: 'notes.txt' }] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(
    rt.store.state.apps.ex.versions[0].files.map((f) => [f.name, f.size]),
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
    rt.store.state.apps.ex.versions[1].files.map((f) => f.name),
    ['pairs.json', 'readme'],
  );
  await call('update_app', { id: 'ex', code: '<p>3</p>', files: [{ name: 'readme', path: 'notes.txt' }] });
  assert.equal((await rt.appFile('ex', 'readme')).toString(), 'changed');
  assert.equal((await rt.appFile('ex', 'readme', 1)).toString(), 'hello');
  await assert.rejects(() => rt.appFile('ex', 'pairs.json'), /no file/);
});

test('#54: a call can’t attach a file Postbox stored for someone else, or more files than the limit', async () => {
  const { rt, folder, call } = await setup();
  const { sha256 } = await arrange.storeBlob(rt, Buffer.from('the person’s upload'));
  const r = await call('show_app', { id: 'ex', title: 'E', code: '<p>x</p>', files: [{ name: 'stolen', sha256, size: 19 }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /needs a path/);
  await writeFile(join(folder, 'a.txt'), 'a');
  const many = Array.from({ length: LIMITS.appFiles + 1 }, (_, i) => ({ name: `f${i}`, path: 'a.txt' }));
  assert.match((await call('show_app', { id: 'ex', title: 'E', code: '<p>x</p>', files: many })).text, /up to 8 data files/);
  assert.match((await call('show_app', { id: 'ex', title: 'E', code: '<p>x</p>', files: [{ name: '../x', path: 'a.txt' }] })).text, /can’t name a file/);
  assert.equal(rt.store.state.apps.ex, undefined);
});

test('#54: a read stops one byte past its limit, so a file that grew after its size was checked is refused', async () => {
  const dir = tempDir('pb-capped-');
  const f = join(dir, 'f');
  await writeFile(f, 'x'.repeat(10));
  assert.equal(await readCapped(f, 9), null);
  assert.equal((await readCapped(f, 10)).toString(), 'x'.repeat(10));
  // Past one chunk, too.
  await writeFile(f, 'y'.repeat(2 * 1024 * 1024 + 5));
  assert.equal(await readCapped(f, 2 * 1024 * 1024 + 4), null);
  assert.equal((await readCapped(f, 3 * 1024 * 1024)).length, 2 * 1024 * 1024 + 5);
});

test('#1751: update_app with only new data files keeps the code, and a call with neither is refused in its own reply', async () => {
  const { rt, folder, call } = await setup();
  await writeFile(join(folder, 'rows.csv'), 'a,1\n');
  assert.equal((await call('show_app', { id: 'panel', title: 'Panel', code: '<p>panel</p>', files: ['rows.csv'] })).isError, false);
  await writeFile(join(folder, 'rows.csv'), 'a,1\nb,2\n');
  const refreshed = await call('update_app', { id: 'panel', files: ['rows.csv'], summary: 'new rows' });
  assert.equal(refreshed.isError, false, refreshed.text);
  assert.match(refreshed.text, /App panel is now v2/);
  const [v1, v2] = rt.store.state.apps.panel.versions;
  assert.equal(v2.code, v1.code, 'the code carries over');
  assert.notEqual(v2.files[0].sha256, v1.files[0].sha256, 'the new data replaces the old');
  assert.equal(String(await rt.apps.appFile('panel', 'rows.csv', 2).then((f) => f.bytes ?? f)), 'a,1\nb,2\n');
  // Neither code nor files: nothing to make a version of, said in the call’s own reply.
  const empty = await call('update_app', { id: 'panel', summary: 'nothing' });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /Send code, codePath or files/);
  assert.equal((await call('update_app', { id: 'panel', code: null })).isError, true, 'a null code is no code');
  // show_app on its own app with files alone does the same, and keeps the app’s permissions.
  assert.equal((await call('update_app', { id: 'panel', code: '<p>panel</p>', permissions: ['assets.search'] })).isError, false);
  const shown = await call('show_app', { id: 'panel', title: 'Panel', files: ['rows.csv'] });
  assert.equal(shown.isError, false, shown.text);
  const last = rt.store.state.apps.panel.versions.at(-1);
  assert.deepEqual([last.code, last.permissions], ['<p>panel</p>', ['assets.search']]);
});
