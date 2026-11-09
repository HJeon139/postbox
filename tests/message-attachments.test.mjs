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
const forged = { kind: 'file', fileId: 'f1', name: `report${RLO}fdp.exe`, type: 'application/pdf', size: 1, path: '/etc/passwd' };
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

test('#991 a file attachment whose upload isn’t known keeps only its id and its name, cleaned as an upload’s, or “file”', async () => {
  const { rt, store, t } = room();
  const sent = { kind: 'file', fileId: 'gone', name: `a${RLO}b.txt`, type: `x${RLO}exe.fdp`, size: 3, path: 'other' };
  const unnamed = { kind: 'file', fileId: 'gone' };
  const { item } = rt.sendMessage(t.id, { text: '@beta read this', attachments: [sent, unnamed] });
  assert.deepEqual(store.state.items[t.id].find((i) => i.id === item.id).attachments, [
    { kind: 'file', fileId: 'gone', name: 'a_b.txt' },
    { kind: 'file', fileId: 'gone', name: 'file' },
  ]);
  await settle(rt);
});

test('#991 attachments that aren’t a list of objects are refused with a 422, and nothing is posted', () => {
  const { rt, store, t } = room();
  for (const attachments of ['report.exe', { kind: 'file', fileId: 'f1' }, null, [null], ['f1']])
    assert.throws(
      () => rt.sendMessage(t.id, { text: '@beta read this', attachments }),
      (e) => e.status === 422 && e.message === 'attachments is a list of files, each an object.',
      JSON.stringify(attachments),
    );
  assert.deepEqual(store.state.items[t.id] ?? [], [], 'nothing posted');
});

test('#991 a project file is attached by its path, and one whose path holds a bidi or invisible character is refused', async () => {
  const { rt, store, t } = room();
  const kept = [
    { kind: 'project-file', path: 'notes/plan.md' },
    { kind: 'project-file', path: 'notes/❤\ufe0f 👨\u200d👩 क्\u200dष.md' },
  ];
  // A project file keeps only its kind and path: a fileId sent beside it would make its chip open another upload.
  const sentKept = kept.map((a) => ({ ...a, fileId: 'f1', name: 'other.md', type: 'text/html' }));
  const { item } = rt.sendMessage(t.id, { text: '@beta read this', attachments: sentKept });
  assert.deepEqual(store.state.items[t.id].find((i) => i.id === item.id).attachments, kept, 'VS16 and ZWJ in emoji and words, as an upload’s name keeps them');
  await settle(rt);
  const before = store.state.items[t.id].length;
  // #1067: a VS16 or ZWJ is held to where it shows or joins, as an upload’s name has it.
  for (const path of [`notes/report${RLO}dm.exe`, 'notes/a\u200bb.md', 'notes/a\u0085b.md', 'notes/ \u200d.md', 'notes/\ufe0fa.md'])
    assert.throws(
      () => rt.sendMessage(t.id, { text: '@beta read this', attachments: [{ kind: 'project-file', path }] }),
      (e) => e.status === 422 && /can’t be attached/.test(e.message),
      JSON.stringify(path),
    );
  assert.equal(store.state.items[t.id].length, before, 'nothing posted');
});

// #1067: an upload stored before #991’s cleaning kept its raw name, and a message that attaches it took that name
// from the record. It’s cleaned where the message reads it, and the record is left as it was stored.
test('#1067 a file attachment whose upload was stored under a raw name has it cleaned, in the message and the prompt', async () => {
  const { rt, store, adapter, t, beta } = setup();
  const old = { id: 'f0', name: `report${RLO}fdp.exe`, type: 'application/x-msdownload', size: 5, sha256: SHA, at: 1, inCorpus: false };
  store.emit('file', old);
  const { item } = rt.sendMessage(t.id, { text: '@beta read this', attachments: [{ kind: 'file', fileId: 'f0' }] });
  assert.deepEqual(store.state.items[t.id].find((i) => i.id === item.id).attachments, [{ ...KEPT, fileId: 'f0' }]);
  assert.match(rt.describeItem(item), /\[attached: report_fdp\.exe\]/);
  await settle(rt);
  const prompt = formatMessage(adapter.calls.find((c) => c.sessionId === beta.id).message);
  assert.match(prompt, /^- report_fdp\.exe \(application\/x-msdownload\)$/m);
  assert.ok(!prompt.includes(RLO), prompt);
  assert.equal(store.state.files.f0.name, old.name, 'the stored record isn’t rewritten');
});

const NO_PATH = 'A project file is attached by its path, and this one was sent without a path. Attach it again from the project’s files.';

test('#1067 a project file sent without a path is refused with a 422, and nothing is posted', () => {
  const { rt, store, t } = room();
  for (const path of [undefined, null, '', 7])
    assert.throws(
      () => rt.sendMessage(t.id, { text: '@beta read this', attachments: [{ kind: 'project-file', path }] }),
      (e) => e.status === 422 && e.message === NO_PATH,
      JSON.stringify(path),
    );
  assert.deepEqual(store.state.items[t.id] ?? [], [], 'nothing posted');
});

// #1067: each stored name, as an old record could hold it, and the name the message shows. Quotes, < and & are text,
// since the chip shows the name through h(); a NUL, a new line, a lone surrogate, a tag character, or a VS16 or ZWJ
// that shows or joins nothing is “_”, a flag stays whole, and a name cleaned is cut at 200 characters as an upload’s
// is. A name with nothing to clean is kept as stored.
const STORED = [
  ['a"<&b.txt', 'a"<&b.txt'],
  ['a\u0000b.txt', 'a_b.txt'],
  ['a\nb\r.txt', 'a_b_.txt'],
  ['a\ud800b.txt', 'a_b.txt'],
  ['a\udc00.txt', 'a_.txt'],
  ['a\u{e0041}b.txt', 'a_b.txt'],
  ['\ufe0fa.txt', '_a.txt'],
  ['❤a\ufe0f.txt', '❤a_.txt'],
  ['a \u200d.txt', 'a _.txt'],
  ['🏴\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f} ❤\ufe0f.txt', '🏴\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f} ❤\ufe0f.txt'],
  [`${'a'.repeat(250)}${RLO}.txt`, 'a'.repeat(200)],
  [`a/b${RLO}.txt`, 'a_b_.txt'],
  ['a/b.txt', 'a/b.txt'],
];

test('#1067 a stored name with a quote, <, &, NUL, lone surrogate or tag character is shown cleaned, and the record kept', async () => {
  const { rt, store, t } = setup();
  for (const [i, [name]] of STORED.entries()) store.emit('file', { id: `f${i}`, name, type: 'text/plain', size: 1, sha256: SHA, at: 1, inCorpus: false });
  const attachments = STORED.map((_, i) => ({ kind: 'file', fileId: `f${i}` }));
  const { item } = rt.sendMessage(t.id, { text: '@beta read these', attachments });
  const shown = store.state.items[t.id].find((x) => x.id === item.id).attachments.map((a) => a.name);
  const kept = STORED.map(([, name]) => name);
  assert.deepEqual(shown, kept);
  for (const [i, [name]] of STORED.entries()) assert.equal(store.state.files[`f${i}`].name, name, 'the stored record isn’t rewritten');
  await settle(rt);
});

test('#1067 a project file’s path with a NUL, a new line or a lone surrogate is refused, and one with a quote, < or & is kept', async () => {
  const { rt, store, t } = room();
  const { item } = rt.sendMessage(t.id, { text: '@beta read this', attachments: [{ kind: 'project-file', path: 'notes/a"<&b.md' }] });
  assert.deepEqual(store.state.items[t.id].find((x) => x.id === item.id).attachments, [{ kind: 'project-file', path: 'notes/a"<&b.md' }]);
  await settle(rt);
  const before = store.state.items[t.id].length;
  for (const path of ['notes/a\u0000b.md', 'notes/a\nb.md', 'notes/a\ud800b.md', 'notes/a\udc00.md', 'notes/a\u{e0041}b.md'])
    assert.throws(
      () => rt.sendMessage(t.id, { text: '@beta read this', attachments: [{ kind: 'project-file', path }] }),
      (e) => e.status === 422 && /can’t be attached/.test(e.message),
      JSON.stringify(path),
    );
  assert.equal(store.state.items[t.id].length, before, 'nothing posted');
});
