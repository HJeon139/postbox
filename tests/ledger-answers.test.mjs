// The work ledger's answers to the page (server/ledger-answers.mjs), with a commit held in its fsync (#601). The person
// aims a restore at the file as the Work view shows it, so it reads what was published, not a change still held behind
// the commit (designs/508/601-held-view.md, §4). The store and its hold are tests/stop-reply-fixture.mjs's.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Ledger } from '../server/ledger.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const snap = (s) => ({ exists: true, size: s.length, sha256: sha(s), binary: false });

/** File access with one file, /proj/a.txt, holding `text`; it records each write and removal. */
function oneFile(text) {
  const calls = [];
  const read = async () => ({ exists: true, bytes: Buffer.from(text) });
  const done = (name) => async (path) => {
    calls.push(`${name} ${path}`);
  };
  return { calls, read, readNow: read, readTail: read, writeAtomic: done('writeAtomic'), remove: done('remove') };
}

test('restore of a file whose newer change is held behind a commit refuses, as the file the person sees has changed since', async () => {
  const h = await heldStore();
  const { store } = h;
  // On disk the agent's newer change, held below, which the Work view doesn't show yet.
  const io = oneFile('second');
  const ledger = new Ledger({ store, io, git: async () => ({ code: 1, stdout: '', stderr: '' }) });
  await ledger.blobs.put(Buffer.from('first'));
  store.emit('work.add', {
    convId: 'th_1',
    entry: { id: 'wf_1', kind: 'file', path: '/proj/a.txt', rel: 'a.txt', before: { exists: false }, after: snap('first'), added: 1, deleted: 0 },
  });
  await store.flush();
  h.hold();
  const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  store.emit('work.patch', { convId: 'th_1', id: 'wf_1', patch: { after: snap('second') } });
  await assert.rejects(ledger.restore('th_1', 'wf_1'), (e) => e.status === 409 && /changed after/.test(e.message));
  assert.deepEqual(io.calls, [], 'nothing written or removed');
  h.release();
  await commit;
  await store.flush();
  await store.close();
});
