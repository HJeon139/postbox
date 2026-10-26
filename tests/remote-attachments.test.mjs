// A message’s attachments on a remote turn (#120): start.attachments in the protocol, reading them on this computer
// (server/remote/attachments.mjs), and the runtime carrying them through prepare, or refusing a message over a limit
// before the turn starts. The adapters are in tests/remote-attachments-adapters.test.mjs, the daemon’s side in
// tests/remote-attachments-host.test.mjs.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Blobs } from '../server/blobs.mjs';
import { carryAttachments, hostName } from '../server/remote/attachments.mjs';
import { encode, message, REMOTE_LIMITS, validateMessage } from '../shared/remote-protocol.mjs';
import { FILE_RE } from '../shared/remote-protocol-checks.mjs';
import { start } from './remote-protocol-cases.mjs';
import { messageOf, rig, settled, starts, until } from './remote-turns-helpers.mjs';

const MiB = 1024 * 1024;
/** NUL, 0xFF, a newline and 0xFE: bytes no text decoding keeps. */
const BYTES = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x00, 0xfe]);
/** Base64 that decodes to n × 3 bytes. @param {number} n */
const groups = (n) => 'AAAA'.repeat(n);
const startWith = (attachments) => validateMessage('postbox-to-daemon', { type: 'start', ...start, attachments });
const errorOf = (r) => (r.ok ? '' : r.error);

test('#120: start.attachments carry any bytes as base64, up to their limits counted in decoded bytes', () => {
  assert.ok(startWith([{ name: '1-chart.png', base64: BYTES.toString('base64') }]).ok, 'NUL and 0xFF cross');
  assert.ok(startWith([]).ok);
  assert.ok(validateMessage('postbox-to-daemon', { type: 'start', ...start }).ok, 'attachments are optional');
  const atLimit = groups(REMOTE_LIMITS.attachmentBytes / 3);
  assert.ok(startWith([{ name: 'a', base64: atLimit }]).ok, 'a file of exactly attachmentBytes');
  assert.match(errorOf(startWith([{ name: 'a', base64: `${atLimit}AA==` }])), /start\.attachments\[0\] \(a\) is 3145729 bytes; the limit is 3145728/);
  // Two files, each under the one-file limit, over the limit for them all.
  const two = groups(700_000);
  assert.match(
    errorOf(
      startWith([
        { name: 'a', base64: two },
        { name: 'b', base64: two },
      ]),
    ),
    /start\.attachments are over 3670016 bytes in all/,
  );
  const many = Array.from({ length: REMOTE_LIMITS.attachments + 1 }, (_, i) => ({ name: `f${i}`, base64: '' }));
  assert.match(errorOf(startWith(many)), /start\.attachments has 17 entries; the limit is 16/);
});

test('#120: a start with every field at its limit, attachments too, still fits in one line', () => {
  const big = 'x'.repeat(REMOTE_LIMITS.fileBytes);
  const env = Object.fromEntries(Array.from({ length: REMOTE_LIMITS.envVars }, (_, i) => [`V${i}`, 'x'.repeat(REMOTE_LIMITS.envValueBytes)]));
  const argv = Array.from({ length: REMOTE_LIMITS.argvBytes / (REMOTE_LIMITS.argBytes + 1) }, () => 'x'.repeat(REMOTE_LIMITS.argBytes));
  const half = REMOTE_LIMITS.attachmentsBytes - REMOTE_LIMITS.attachmentBytes;
  const attachments = [
    { name: 'a', base64: groups(REMOTE_LIMITS.attachmentBytes / 3) },
    { name: 'b', base64: Buffer.alloc(half).toString('base64') },
  ];
  const files = [...start.files.map((f) => ({ ...f, text: big })), { name: 'extra', text: big }];
  const m = message('postbox-to-daemon', 'start', { ...start, argv, env, files, attachments });
  assert.ok(encode(m).length <= REMOTE_LIMITS.lineBytes + 1);
});

test('#120: an attachment’s name on the host is plain, numbered, at most 64 characters, and keeps its extension', () => {
  assert.equal(hostName({ kind: 'file', name: 'chart (1).png' }, 0), '1-chart_1_.png');
  assert.equal(hostName({ kind: 'project-file', path: 'docs/../notes.md' }, 1), '2-notes.md');
  assert.equal(hostName({ kind: 'file', name: 'a..b' }, 2), '3-a.b');
  assert.equal(hostName({ kind: 'file', name: '' }, 0), '1-file');
  const long = hostName({ kind: 'file', name: `${'é'.repeat(30)}${'x'.repeat(80)}.tar` }, 9);
  assert.ok(long.length <= 64 && long.startsWith('10-') && long.endsWith('.tar'), long);
  for (const n of ['1-chart_1_.png', long, hostName({ kind: 'file', name: '../../.ssh/id_ed25519' }, 0)]) assert.ok(FILE_RE.test(n) && !n.includes('..'), n);
});

test('#120: the attachments a remote turn carries are read from this computer, byte for byte; one with no path here has none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-attach-'));
  try {
    writeFileSync(join(dir, 'blob'), BYTES);
    const a = { kind: 'file', fileId: 'fi_1', name: 'chart (1).png', type: 'image/png' };
    const gone = { kind: 'file', fileId: 'fi_gone', name: 'gone.txt' };
    const carried = await carryAttachments({ kind: 'user', text: 'Look', attachments: [gone, a] }, (x) => (x === a ? join(dir, 'blob') : null));
    assert.deepEqual(carried, [{ of: a, name: '1-chart_1_.png', base64: BYTES.toString('base64') }]);
    assert.deepEqual(await carryAttachments({ kind: 'wake', note: 'x' }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#120: a message over an attachment limit is refused, naming the limit, and one that can’t be read says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-attach-'));
  try {
    writeFileSync(join(dir, 'big'), Buffer.alloc(REMOTE_LIMITS.attachmentBytes + 1));
    writeFileSync(join(dir, 'two'), Buffer.alloc(2 * MiB));
    writeFileSync(join(dir, 'tiny'), 'x');
    const of = (name, path) => ({ a: { kind: 'file', fileId: name, name }, path: join(dir, path) });
    const carry = (list) => carryAttachments({ kind: 'user', text: '', attachments: list.map((x) => x.a) }, (a) => list.find((x) => x.a === a)?.path ?? null);
    await assert.rejects(carry([of('scan.pdf', 'big')]), /^Error: “scan\.pdf” is 3\.1 MB, and a file sent to an agent on a host can be at most 3 MB\./);
    await assert.rejects(carry([of('a.bin', 'two'), of('b.bin', 'two')]), /come to over 3\.5 MB, the most one message to an agent on a host can carry/);
    const many = Array.from({ length: REMOTE_LIMITS.attachments + 1 }, (_, i) => of(`n${i}.txt`, 'tiny'));
    await assert.rejects(carry(many), /has 17 files attached, and one message to an agent on a host can carry at most 16/);
    await assert.rejects(carry([of('lost.txt', 'nowhere')]), /Couldn’t read “lost\.txt” to send it to the host: ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A runtime with a remote persona, and an upload in its blob store. @param {Buffer} bytes */
async function withUpload(bytes) {
  const r = rig();
  const dir = mkdtempSync(join(tmpdir(), 'pb-attach-blobs-'));
  r.rt.blobs = new Blobs(dir);
  const { sha256 } = await r.rt.blobs.put(bytes);
  r.store.emit('file', { id: 'fi_1', name: 'chart (1).png', size: bytes.length, type: 'image/png', sha256, at: 1, inCorpus: false });
  const a = { kind: 'file', fileId: 'fi_1', name: 'chart (1).png', type: 'image/png' };
  return { r, a, blob: r.rt.blobs.pathOf(sha256), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('#120: the runtime carries an upload to the host with the turn, and the agent’s message names the copy there', async () => {
  const { r, a, blob, done } = await withUpload(BYTES);
  try {
    r.rt.sendMessage(r.t.id, { text: 'Look at this.', attachments: [a] });
    await until(() => starts(r.d).length === 1 && r.d.turns.has(starts(r.d)[0].turn), 'the start');
    const [s] = starts(r.d);
    assert.deepEqual(s.attachments, [{ name: '1-chart_1_.png', base64: BYTES.toString('base64') }]);
    const text = messageOf(s);
    assert.ok(text.includes(`chart (1).png (image/png): /home/user/.postbox-remote/turns/${s.turn}/attachments/1-chart_1_.png`), text);
    assert.ok(!text.includes(blob), 'the blob store’s path on this computer isn’t named');
    r.d.end(s.turn);
    await settled(r);
  } finally {
    done();
  }
});

test('#120: a message with an attachment over the limit is refused before the turn starts, naming the limit', async () => {
  const { r, a, done } = await withUpload(Buffer.alloc(REMOTE_LIMITS.attachmentBytes + 1));
  try {
    r.rt.sendMessage(r.t.id, { text: 'Look at this.', attachments: [a] });
    await until(() => r.store.items(r.t.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'the refusal');
    const failed = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
    assert.match(failed.error, /“chart \(1\)\.png” is 3\.1 MB, and a file sent to an agent on a host can be at most 3 MB/);
    await settled(r);
    assert.equal(starts(r.d).length, 0, 'nothing started on the host');
    assert.equal(r.d.received.filter((m) => m.type === 'snapshot').length, 0, 'nor was the host asked for anything');
  } finally {
    done();
  }
});
