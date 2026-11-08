// The outage path of a delivery that waits for a new agent's session (#796's class in sessions, server/store-outage.mjs
// heldSession): the person @-mentions an agent behind a held commit, and the sync after the release fails, so writes
// close before the flush settles. Retry reloads what the disk kept, and the message gets its turn once writes reopen.

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { settle, setup, sleep } from './side-threads-fixture.mjs';
import { disk, handleWith } from './store-jsonl-fixture.mjs';

/**
 * A store whose next log sync is held once hold() is called, and whose sync after that one throws EIO, or passes with
 * hold('pass'). hold() returns the promise of the sync being reached. @param {import('node:test').TestContext} t
 */
async function outageStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-session-outage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  /** @type {'pass' | 'hold' | 'fail'} */
  let mode = 'pass';
  /** @type {'pass' | 'fail'} */
  let then = 'fail';
  let release = () => {};
  let reached = () => {};
  const io = disk({
    open: async (path, ...args) => {
      const fh = await fs.open(path, ...args);
      if (!/events-\d+\.jsonl$/.test(String(path))) return fh;
      return handleWith(fh, {
        sync: async () => {
          if (mode === 'hold') {
            mode = then;
            reached();
            await new Promise((r) => {
              release = () => r(undefined);
            });
            return fh.sync();
          }
          if (mode === 'fail') {
            mode = 'pass';
            throw Object.assign(new Error('disk sync refused'), { code: 'EIO' });
          }
          return fh.sync();
        },
      });
    },
  });
  const store = await new Store(dir, { io }).load();
  /** @param {'pass' | 'fail'} [after] */
  const hold = (after = 'fail') => {
    mode = 'hold';
    then = after;
    return new Promise((r) => {
      reached = () => r(undefined);
    });
  };
  return { store, dir, hold, release: () => release() };
}

test('your first @-mention of an agent behind a held commit, when the next sync fails, gets its turn after Retry', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = await outageStore(t);
  const f = setup(h.store);
  await h.store.flush();
  const atSync = h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await atSync;
  f.rt.sendMessage(f.t.id, { text: '@gamma Check the totals.' });
  h.release();
  await commit;
  await h.store.flush().catch(() => {}); // rejects: the sync after the release failed, and writes closed
  for (let i = 0; i < 200 && h.store.writable; i++) await sleep(5);
  assert.equal(h.store.writable, false, 'writes closed');
  assert.equal(f.adapter.calls.length, 0, 'no turn while writes are closed');
  await h.store.reload();
  await settle(f.rt);
  assert.ok(
    Object.values(h.store.state.sessions).some((x) => x.handle === 'gamma'),
    'the disk kept the new session',
  );
  assert.deepEqual(
    f.adapter.calls.filter((c) => c.handle === 'gamma').map((c) => c.message.text),
    ['@gamma Check the totals.'],
  );
  await h.store.close();
});

test('after Retry and after a restart, a pending read holds what the disk kept, and then what the next held commit holds', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = await outageStore(t);
  const f = setup(h.store);
  await h.store.flush();
  const atSync = h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await atSync;
  f.rt.tellAgent(f.alpha.id, 'Held notice.');
  f.rt.renameThread(f.t.id, 'Renamed behind the commit');
  h.release();
  await commit;
  await h.store.flush().catch(() => {}); // rejects: the sync after the release failed, and writes closed
  for (let i = 0; i < 200 && h.store.writable; i++) await sleep(5);
  await h.store.reload();
  const kept = h.store.state.sessions[f.alpha.id];
  assert.deepEqual(kept.context, ['[Postbox] Held notice.'], 'the disk kept the held notice');
  assert.equal(h.store.pending.session(f.alpha.id), kept, 'with nothing held, the pending read is the published session');
  assert.equal(h.store.pending.thread(f.t.id).title, 'Renamed behind the commit');
  // The next held commit's view starts from the state Retry installed.
  const again = h.hold('pass');
  const second = h.store.commit([{ type: 'settings', data: { theme: 'dark' } }]);
  await again;
  f.rt.tellAgent(f.alpha.id, 'Second notice.');
  assert.deepEqual(h.store.pending.session(f.alpha.id).context, ['[Postbox] Held notice.', '[Postbox] Second notice.']);
  assert.deepEqual(h.store.state.sessions[f.alpha.id].context, ['[Postbox] Held notice.'], 'still held');
  h.release();
  await second;
  await h.store.flush();
  await h.store.close();
  const restarted = await new Store(h.dir).load();
  assert.deepEqual(restarted.pending.session(f.alpha.id).context, ['[Postbox] Held notice.', '[Postbox] Second notice.']);
  assert.equal(restarted.pending.thread(f.t.id).title, 'Renamed behind the commit');
  await restarted.close();
});
