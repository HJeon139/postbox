// A message’s attachments on the host (#120): the daemon writes start.attachments under the turn folder, 0600 in a 0700
// folder (fake runners, tests/remote-daemon-setup.mjs), and cleanup removes them with the turn’s other files when it
// ends, never following a link (tests/remote-cleanup-setup.mjs). The real daemon and runner are in
// tests/integration/remote-attachments.test.mjs.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ATTACHMENTS_DIR, TURN_FILES } from '../shared/remote-protocol.mjs';
import { setup as cleanupSetup, ls, makeTurn } from './remote-cleanup-setup.mjs';
import { hello, setup, startMsg } from './remote-daemon-setup.mjs';

const BYTES = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x00, 0xfe]);

test('#120: start writes each attachment, decoded, in the turn folder’s attachments folder: 0700, each file 0600', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    const attachments = [
      { name: '1-chart_1_.png', base64: BYTES.toString('base64') },
      { name: '2-notes.md', base64: Buffer.from('# Notes\n').toString('base64') },
    ];
    c.send('start', startMsg('t1', { attachments }));
    await c.msgs.next('started');
    const dir = s.p.turn('t1', ATTACHMENTS_DIR);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(readFileSync(join(dir, '1-chart_1_.png')), BYTES);
    assert.equal(readFileSync(join(dir, '2-notes.md'), 'utf8'), '# Notes\n');
    for (const f of ['1-chart_1_.png', '2-notes.md']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
    // A start without any makes no folder.
    c.send('start', startMsg('t2'));
    await c.msgs.next('started');
    assert.equal(existsSync(s.p.turn('t2', ATTACHMENTS_DIR)), false);
  } finally {
    s.done();
  }
});

test('#120: an ended turn’s attachments go with its other files, and their folder too', async () => {
  const s = cleanupSetup();
  try {
    const dir = makeTurn(s.p, 't1');
    mkdirSync(join(dir, ATTACHMENTS_DIR), { mode: 0o700 });
    writeFileSync(join(dir, ATTACHMENTS_DIR, '1-chart.png'), BYTES, { mode: 0o600 });
    writeFileSync(join(dir, ATTACHMENTS_DIR, '2-notes.md'), 'x', { mode: 0o600 });
    await s.cleanup.turnEnded('t1');
    assert.equal(existsSync(join(dir, ATTACHMENTS_DIR)), false);
    assert.ok(ls(dir).includes(TURN_FILES.exit), 'the turn’s record stays');
  } finally {
    s.done();
  }
});

test('#120: an attachments folder that’s a link is unlinked, never followed, and a folder the agent made in it keeps it', async () => {
  const s = cleanupSetup();
  const outside = mkdtempSync(join(tmpdir(), 'pb-outside-'));
  try {
    writeFileSync(join(outside, 'keep.txt'), 'mine');
    const linked = makeTurn(s.p, 't1');
    symlinkSync(outside, join(linked, ATTACHMENTS_DIR));
    const made = makeTurn(s.p, 't2');
    mkdirSync(join(made, ATTACHMENTS_DIR, 'unpacked'), { recursive: true });
    writeFileSync(join(made, ATTACHMENTS_DIR, '1-a.zip'), 'zip');
    await s.cleanup.turnEnded('t1');
    await s.cleanup.turnEnded('t2');
    assert.equal(existsSync(join(linked, ATTACHMENTS_DIR)), false, 'the link went');
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'mine', 'what it pointed to stays');
    assert.deepEqual(ls(join(made, ATTACHMENTS_DIR)), ['unpacked'], 'the file went; the folder waits for logRetention');
    assert.ok(s.logs.some((l) => l.includes(`Couldn’t delete ${join(made, ATTACHMENTS_DIR)}`)));
  } finally {
    s.done();
    rmSync(outside, { recursive: true, force: true });
  }
});
