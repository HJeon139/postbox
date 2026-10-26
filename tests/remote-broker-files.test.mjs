// The daemon’s broker (server/remote/host/broker.mjs, #120), driven in-process: files in the agent’s folder, read for
// show_app and update_app. A shim is a pair of functions, Postbox is a list of what the broker sent it, and the turn
// folders are in a temp home (tests/remote-broker-fixtures.mjs). Nothing is spawned; the real daemon, runner and shim
// are in tests/integration/remote-broker.test.mjs.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inlineAppFiles } from '../server/remote/host/broker.mjs';
import { connectShim, makeBroker, makeHome } from './remote-broker-fixtures.mjs';

// ── Files in the agent’s folder ──

test('show_app’s codePath and files are read from the turn’s folder, never outside it, under the laptop’s limits', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    writeFileSync(join(h.work, 'app.html'), '<p>hi</p>');
    writeFileSync(join(h.work, 'data.csv'), 'a,b\n1,2\n');
    mkdirSync(join(h.work, 'sub'));
    writeFileSync(join(h.home, 'secret.txt'), 'no');
    symlinkSync(join(h.home, 'secret.txt'), join(h.work, 'link.txt'));
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    assert.equal(
      (await s.call('c1', 'show_app', { id: 'app_1', title: 'Hi', codePath: 'app.html', files: [{ path: 'data.csv' }, { name: 'n.txt', path: './data.csv' }] }))
        .ok,
      true,
    );
    assert.deepEqual(k.sent[0].args, {
      id: 'app_1',
      title: 'Hi',
      code: '<p>hi</p>',
      files: [
        { name: 'data.csv', base64: Buffer.from('a,b\n1,2\n').toString('base64') },
        { name: 'n.txt', base64: Buffer.from('a,b\n1,2\n').toString('base64') },
      ],
    });
    const refused = async (id, args) => {
      const r = await s.call(id, 'update_app', { id: 'app_1', ...args });
      assert.equal(r.ok, false, JSON.stringify(args));
      return r.text;
    };
    assert.equal(await refused('c2', { codePath: '../secret.txt' }), '../secret.txt is outside your folder, so Postbox didn’t read it (codePath).');
    assert.equal(await refused('c3', { codePath: 'link.txt' }), 'link.txt is outside your folder, so Postbox didn’t read it (codePath).');
    assert.equal(await refused('c4', { codePath: 'nope.html' }), 'There’s no file at nope.html (codePath).');
    assert.equal(await refused('c5', { codePath: 'sub' }), 'sub isn’t a file (codePath).');
    assert.equal(await refused('c6', { code: '<p>x</p>', codePath: 'app.html' }), 'Send code or codePath, not both.');
    assert.equal(
      await refused('c7', { code: 'x', files: [{ name: 'a b', path: 'data.csv' }] }),
      '“a b” can’t name a file: use letters, digits and - _ . (up to 64).',
    );
    assert.equal(await refused('c8', { code: 'x', files: [{ path: 'data.csv' }, { path: 'sub/../data.csv' }] }), 'Two files are named “data.csv”.');
    // A file Postbox made itself can’t be named by the call.
    assert.equal(
      await refused('c9', { code: 'x', files: [{ name: 'f', base64: 'eA==' }] }),
      'the file “f” (up to 20 MB) needs a path to a file in your folder.',
    );
    assert.equal(k.sent.length, 1, 'nothing refused crossed');
    // Over what one message from the host can carry, once read: refused, saying so.
    writeFileSync(join(h.work, 'big.bin'), Buffer.alloc(13 * 1024 * 1024));
    assert.match(await refused('c10', { code: 'x', files: [{ path: 'big.bin' }] }), /^update_app comes to 17\.\d MiB once its files are read, over the 16 MiB/);
    const direct = await inlineAppFiles(h.work, { code: 'x' });
    assert.deepEqual(direct, { ok: true, args: { code: 'x' } }, 'without codePath and files, the call is unchanged');
  } finally {
    h.done();
  }
});

test('a file swapped for a link after it was checked isn’t read: the file opened is checked, not the path', async () => {
  const h = makeHome();
  try {
    const secret = join(h.home, 'secret');
    mkdirSync(secret);
    writeFileSync(join(secret, 'app.html'), 'credential');
    writeFileSync(join(h.work, 'app.html'), '<p>hi</p>');
    mkdirSync(join(h.work, 'sub'));
    writeFileSync(join(h.work, 'sub', 'app.html'), '<p>hi</p>');
    /** Runs once, between the containment check and the open, as an agent racing the broker would. */
    const between = (swap) => {
      let done = false;
      return {
        beforeOpen: (real) => {
          if (done) return;
          done = true;
          swap(real);
        },
      };
    };
    // The file itself becomes a link to one outside.
    const file = await inlineAppFiles(
      h.work,
      { codePath: 'app.html' },
      between((real) => {
        rmSync(real);
        symlinkSync(join(secret, 'app.html'), real);
      }),
    );
    assert.deepEqual(file, { ok: false, text: 'app.html is outside your folder, so Postbox didn’t read it (codePath).' });
    // A folder on its path becomes a link to one outside.
    const dir = await inlineAppFiles(
      h.work,
      { code: 'x', files: [{ path: 'sub/app.html' }] },
      between(() => {
        rmSync(join(h.work, 'sub'), { recursive: true });
        symlinkSync(secret, join(h.work, 'sub'));
      }),
    );
    assert.deepEqual(dir, { ok: false, text: 'sub/app.html is outside your folder, so Postbox didn’t read it (the file “app.html” (up to 20 MB)).' });
    // Without a swap, the same calls read the files.
    rmSync(join(h.work, 'app.html'));
    writeFileSync(join(h.work, 'app.html'), '<p>hi</p>');
    assert.deepEqual(
      await inlineAppFiles(
        h.work,
        { codePath: 'app.html' },
        between(() => {}),
      ),
      { ok: true, args: { code: '<p>hi</p>' } },
    );
  } finally {
    h.done();
  }
});
