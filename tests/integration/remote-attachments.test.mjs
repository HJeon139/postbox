// A message’s attachments on a host (#120), with the real daemon and runner (tests/integration/host.mjs): a binary file
// in start.attachments lands byte for byte in the turn folder, 0600 in a 0700 folder, and goes when the turn ends; one
// over the protocol’s limit is refused with the reason. The laptop’s side is tests/remote-attachments*.test.mjs.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { encode, PROTOCOL_VERSION, REMOTE_LIMITS } from '../../shared/remote-protocol.mjs';
import { readMessages } from '../fake-daemon.mjs';
import { HARNESS, makeHost, NO_UNIX, realDaemon, TOKEN, TURN, until } from './host.mjs';

/** NUL, 0xFF, a newline and 0xFE: bytes no text decoding keeps. */
const BYTES = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x00, 0xfe, 0x00]);

test('a binary attachment lands byte for byte in the turn folder, 0600 in a 0700 folder, and goes when the turn ends', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const d = realDaemon(h);
  try {
    await d.daemon.start();
    const c = d.connect();
    await c.msgs.next('welcome', 5000);
    const attachments = [
      { name: '1-chart_1_.png', base64: BYTES.toString('base64') },
      { name: '2-empty', base64: '' },
    ];
    const argv = [HARNESS, 'out:ready', 'sleep:1500'];
    c.send('start', { turn: TURN, harness: 'claude-code', folder: h.work, argv, env: {}, stdin: 'none', files: [], attachments });
    await c.msgs.next('started', 10_000);
    const dir = h.p.turn(TURN, 'attachments');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(readFileSync(`${dir}/1-chart_1_.png`), BYTES, 'the same bytes, NUL and 0xFF included');
    assert.equal(readFileSync(`${dir}/2-empty`).length, 0);
    for (const f of ['1-chart_1_.png', '2-empty']) assert.equal(statSync(`${dir}/${f}`).mode & 0o777, 0o600, f);
    // Read to its end, which is when the daemon tidies an ended turn’s files.
    c.send('read', { turn: TURN, from: 0 });
    assert.equal((await c.msgs.next('ended', 15_000)).exit?.code, 0);
    await until(() => !existsSync(dir), 'the attachments to go with the turn’s other files', 5000);
    assert.ok(existsSync(h.p.turn(TURN, 'exit.json')), 'what the turn’s record needs stays');
  } finally {
    d.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test('a start whose attachment is over the limit is refused with the reason, and nothing is written', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const d = realDaemon(h);
  try {
    await d.daemon.start();
    // Written as raw lines: message() would refuse to build this start on Postbox’s side.
    const input = new PassThrough();
    const output = new PassThrough();
    d.daemon.connect({ input, output });
    const msgs = readMessages(output);
    input.write(encode({ type: 'hello', version: PROTOCOL_VERSION, token: TOKEN, takeover: true }));
    await msgs.next('welcome', 5000);
    const base64 = Buffer.alloc(REMOTE_LIMITS.attachmentBytes + 1).toString('base64');
    const start = { type: 'start', turn: TURN, harness: 'claude-code', folder: h.work, argv: [HARNESS], env: {}, stdin: 'none', files: [] };
    input.write(`${JSON.stringify({ ...start, attachments: [{ name: 'big.bin', base64 }] })}\n`);
    const e = await msgs.next('error', 10_000);
    assert.equal(e.code, 'bad-message');
    assert.match(e.message, /start\.attachments\[0\] \(big\.bin\) is 3145729 bytes; the limit is 3145728/);
    assert.equal(existsSync(h.p.turn(TURN)), false, 'no turn folder was made');
  } finally {
    d.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});
