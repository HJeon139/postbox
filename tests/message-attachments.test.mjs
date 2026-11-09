// #991: the attachments a message you send carries (server/message-attachments.mjs). An upload’s name was cleaned
// where it was stored (server/upload-name.mjs), but the message took the name, type and size the page sent, so a
// right-to-left override the upload had replaced still reached the chip and the agents. A file attachment now takes
// them from its upload’s record, and a project file whose path would hide or reorder what it shows is refused.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage } from '../server/adapters/guide.mjs';
import { held, settle, setup } from './side-threads-fixture.mjs';

const RLO = '\u202e';
const SHA = 'ab'.repeat(32);

/** The room, with an upload stored under the name the upload route kept for “report” + RLO + “fdp.exe”. */
function room() {
  const s = setup();
  s.store.emit('file', { id: 'f1', name: 'report_fdp.exe', type: 'application/x-msdownload', size: 5, sha256: SHA, at: 1, inCorpus: false });
  return s;
}
const forged = { kind: 'file', fileId: 'f1', name: `report${RLO}fdp.exe`, type: 'application/pdf', size: 1 };
const KEPT = { kind: 'file', fileId: 'f1', name: 'report_fdp.exe', type: 'application/x-msdownload', size: 5 };

test('#991 a file attachment is stored with its upload’s name, type and size, not the ones the message sent', async () => {
  const { rt, store, t } = room();
  const { item } = rt.sendMessage(t.id, { text: '@beta read this', attachments: [forged] });
  assert.deepEqual(store.state.items[t.id].find((i) => i.id === item.id).attachments, [KEPT]);
  assert.ok(!rt.describeItem(item).includes(RLO), 'the line other agents read');
  assert.match(rt.describeItem(item), /\[attached: report_fdp\.exe\]/);
  await settle(rt);
});

test('#991 the agent a file is sent to reads its upload’s name in the prompt', async () => {
  const { rt, adapter, t, beta } = room();
  rt.sendMessage(t.id, { text: '@beta read this', attachments: [forged] });
  await settle(rt);
  const prompt = formatMessage(adapter.calls.find((c) => c.sessionId === beta.id).message);
  assert.match(prompt, /^- report_fdp\.exe \(application\/x-msdownload\)$/m);
  assert.ok(!prompt.includes(RLO), prompt);
});

test('#991 a message queued behind a busy agent holds its file’s upload name too', async () => {
  const { rt, store, adapter, t } = room();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.sendMessage(t.id, { text: '@beta then this', attachments: [forged] });
  assert.deepEqual(store.state.threads[t.id].queue.at(-1).attachments, [KEPT]);
  busy.release();
  await settle(rt);
});

test('#991 a file attachment whose upload isn’t known is kept, as before, with its name cleaned as an upload’s', async () => {
  const { rt, store, t } = room();
  const sent = { kind: 'file', fileId: 'gone', name: `a${RLO}b.txt`, type: 'text/plain', size: 3 };
  const { item } = rt.sendMessage(t.id, { text: '@beta read this', attachments: [sent] });
  assert.deepEqual(store.state.items[t.id].find((i) => i.id === item.id).attachments, [{ ...sent, name: 'a_b.txt' }]);
  await settle(rt);
});

test('#991 a project file is attached by its path, and one whose path holds a bidi or invisible character is refused', async () => {
  const { rt, store, t } = room();
  const { item } = rt.sendMessage(t.id, { text: '@beta read this', attachments: [{ kind: 'project-file', path: 'notes/plan.md' }] });
  assert.deepEqual(store.state.items[t.id].find((i) => i.id === item.id).attachments, [{ kind: 'project-file', path: 'notes/plan.md' }]);
  await settle(rt);
  const before = store.state.items[t.id].length;
  for (const path of [`notes/report${RLO}dm.exe`, 'notes/a\u200bb.md', 'notes/a\u0085b.md'])
    assert.throws(
      () => rt.sendMessage(t.id, { text: '@beta read this', attachments: [{ kind: 'project-file', path }] }),
      (e) => e.status === 422 && /can’t be attached/.test(e.message),
      JSON.stringify(path),
    );
  assert.equal(store.state.items[t.id].length, before, 'nothing posted');
});
