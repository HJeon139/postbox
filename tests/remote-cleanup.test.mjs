// Cleanup on a remote host (server/remote/host/cleanup.mjs, #120): acks kept on disk, logs deleted once a turn has
// ended and Postbox has acked them, folders past logRetention, the size cap, the agent file, version retirement and
// `remove`. Everything runs over a temp home with a fake process check (sameProcess), so nothing is spawned or
// signaled; the daemon’s side drives createDaemon in-process over PassThrough streams, as tests/remote-daemon.test.mjs
// does.
//
// This file is acks, an ended or running turn, logRetention, the cap and the agent file; tests/remote-cleanup-root.test.mjs
// is version retirement, removeAll and links, and tests/remote-cleanup-daemon.test.mjs the daemon’s side. What they
// share is tests/remote-cleanup-setup.mjs.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACK_FILE, AGENT_RECORD, createCleanup } from '../server/remote/host/cleanup.mjs';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { DAY, ls, makeTurn, RETENTION, setup, VERSION } from './remote-cleanup-setup.mjs';

test('acks persist in the turn folder (0600), keep the furthest, and a new cleanup (a restarted daemon) reads them', async () => {
  const s = setup();
  try {
    const dir = makeTurn(s.p, 't1', { exit: false });
    s.alive.add(777);
    assert.equal(await s.cleanup.readAck('t1'), null);
    assert.equal(await s.cleanup.ack('t1', 8), 8);
    assert.equal(await s.cleanup.ack('t1', 4), 8, 'an older ack doesn’t move it back');
    assert.equal(readFileSync(join(dir, ACK_FILE), 'utf8'), '8\n');
    assert.equal(statSync(join(dir, ACK_FILE)).mode & 0o777, 0o600);
    const again = createCleanup({
      home: s.home,
      version: VERSION,
      paths: s.p,
      settings: () => ({ logRetention: RETENTION, logMaxBytes: 1 << 20 }),
      sameProcess: () => true,
    });
    assert.equal(await again.readAck('t1'), 8);
    assert.ok(existsSync(join(dir, TURN_FILES.out)), 'a running turn’s logs stay, acked or not');
  } finally {
    s.done();
  }
});

test('an ended turn: its files go at once, its logs only once out.jsonl is acked whole, and what welcome needs stays', async () => {
  const s = setup();
  try {
    const dir = makeTurn(s.p, 't1', { files: { 'mcp.json': '{}', 'in.jsonl': 'x\n' } });
    await s.cleanup.turnEnded('t1');
    assert.deepEqual(
      ls(dir),
      [TURN_FILES.err, TURN_FILES.exit, TURN_FILES.in, TURN_FILES.out, TURN_FILES.runner, TURN_FILES.start, TURN_FILES.tools].sort(),
      'the message, snapshot and other sent files went; logs and the queue stayed',
    );
    await s.cleanup.ack('t1', 8);
    assert.ok(existsSync(join(dir, TURN_FILES.out)), 'half acked: the logs stay');
    assert.equal(await s.cleanup.deletedSize('t1'), null);
    await s.cleanup.ack('t1', 16);
    assert.deepEqual(ls(dir), [ACK_FILE, TURN_FILES.exit, TURN_FILES.runner, TURN_FILES.start, TURN_FILES.tools].sort(), 'acked whole: out, in and err went');
    assert.equal(await s.cleanup.deletedSize('t1'), 16, 'the acked size stands in for out.jsonl’s');
  } finally {
    s.done();
  }
});

test('a running or starting turn keeps everything; an interrupted one keeps its logs until logRetention', async () => {
  const s = setup();
  try {
    const running = makeTurn(s.p, 'run', { exit: false, pid: 801 });
    const starting = makeTurn(s.p, 'starting', { exit: false, runner: false });
    const interrupted = makeTurn(s.p, 'gone', { exit: false, pid: 802 });
    s.alive.add(801);
    const before = [ls(running), ls(starting), ls(interrupted)];
    const swept = await s.cleanup.sweep();
    assert.deepEqual([ls(running), ls(starting), ls(interrupted)], before);
    assert.deepEqual(swept.folders, []);
    // Eight days on, the interrupted and starting folders go (nothing in them changed), the running one stays.
    s.time.skew = 8 * DAY;
    const later = await s.cleanup.sweep();
    assert.deepEqual(later.folders.sort(), ['gone', 'starting']);
    assert.ok(existsSync(running));
  } finally {
    s.done();
  }
});

test('logRetention deletes an ended folder whole, acked or not; a younger one stays', async () => {
  const s = setup();
  try {
    makeTurn(s.p, 'old');
    s.time.skew = 6 * DAY;
    assert.deepEqual((await s.cleanup.sweep()).folders, []);
    s.time.skew = RETENTION + 1000;
    assert.deepEqual((await s.cleanup.sweep()).folders, ['old']);
    assert.ok(!existsSync(s.p.turn('old')));
  } finally {
    s.done();
  }
});

test('the cap: a running turn whose out.jsonl passes logMaxBytes is stopped once and Postbox told; err.log is emptied', async () => {
  const s = setup({ logMaxBytes: 64 });
  try {
    const dir = makeTurn(s.p, 't1', { exit: false, out: `${'x'.repeat(100)}\n` });
    writeFileSync(join(dir, TURN_FILES.err), 'e'.repeat(200));
    s.alive.add(777);
    const swept = await s.cleanup.sweep();
    assert.deepEqual(s.stops, ['t1']);
    assert.deepEqual(swept.capped, ['t1']);
    assert.match(s.caps[0].text, /out\.jsonl is 101 bytes, over this host’s logMaxBytes \(64 bytes\)/);
    assert.equal(readFileSync(join(dir, TURN_FILES.out), 'utf8').length, 101, 'out.jsonl isn’t cut under a running turn');
    const err = readFileSync(join(dir, TURN_FILES.err), 'utf8');
    assert.match(err, /^postbox daemon: err\.log passed logMaxBytes \(64 bytes\) at 200 bytes and was emptied\.\n/);
    assert.match(err, /was stopped/);
    await s.cleanup.sweep();
    assert.deepEqual(s.stops, ['t1'], 'stopped once');
  } finally {
    s.done();
  }
});

test('the agent file: written 0600 outside the turn folder, never over a file already there, removed at the turn’s end if unchanged', async () => {
  const s = setup();
  try {
    const agents = join(s.home, '.kiro', 'agents');
    const file = { dir: agents, name: 'postbox.json', text: '{"name":"postbox"}' };
    makeTurn(s.p, 't1', { exit: false, pid: 801 });
    s.alive.add(801);
    await s.cleanup.writeAgentFile('t1', file);
    const path = join(agents, 'postbox.json');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(s.p.turn('t1', AGENT_RECORD), 'utf8')).path, path);
    // A file already there is never replaced or shared, even with the same text, and the refused turn’s record goes.
    makeTurn(s.p, 't2', { exit: false, pid: 802 });
    await assert.rejects(s.cleanup.writeAgentFile('t2', file), /already a file at .*postbox\.json/);
    assert.ok(!existsSync(s.p.turn('t2', AGENT_RECORD)));
    writeFileSync(path, 'theirs');
    await assert.rejects(s.cleanup.writeAgentFile('t2', { ...file, text: 'theirs' }), /already a file/);
    assert.equal(readFileSync(path, 'utf8'), 'theirs');
    writeFileSync(path, file.text);
    writeFileSync(s.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 5 }));
    await s.cleanup.turnEnded('t1');
    assert.ok(!existsSync(path), 'gone with the turn that wrote it');
    assert.ok(!existsSync(s.p.turn('t1', AGENT_RECORD)));
    // One the person changed since is kept.
    makeTurn(s.p, 't4', { exit: false, pid: 804 });
    s.alive.add(804);
    await s.cleanup.writeAgentFile('t4', file);
    writeFileSync(path, '{"mine":true}');
    writeFileSync(s.p.turn('t4', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 7 }));
    await s.cleanup.turnEnded('t4');
    assert.equal(readFileSync(path, 'utf8'), '{"mine":true}');
  } finally {
    s.done();
  }
});
