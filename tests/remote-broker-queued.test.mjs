// The daemon’s answer to a queued call (#827): the host’s shim waits for it, so the daemon gives one once the call’s
// record is written, whatever Postbox did with the call meanwhile. Driven in-process, as tests/remote-broker.test.mjs
// drives it, with the fixtures in tests/remote-broker-fixtures.mjs and a held journal write (remote-settle-io.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUEUED_TEXT } from '../server/remote/host/broker-state.mjs';
import { BLOCK, connectShim, makeBroker, makeHome } from './remote-broker-fixtures.mjs';
import { holdingIo, reached } from './remote-settle-io.mjs';

/**
 * A queued show_block whose record is held while Postbox says hello, takes the call and answers it, then let go.
 * @param {{ reject?: boolean, ok?: boolean }} o  reject: the record’s write fails once let go; ok: Postbox’s answer
 */
async function answeredWhileRecording({ reject = false, ok = true } = {}) {
  const h = makeHome();
  try {
    h.turn('t1');
    const hold = holdingIo((c) => c.kind === 'appendFile' && c.line.includes('"op":"call"'), { reject });
    const k = makeBroker(h, { io: hold.io });
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const got = s.call('c1', 'show_block', { block: BLOCK });
    await reached(hold);
    // Postbox’s hello sends every call not answered yet, this one too, and Postbox answers it.
    const hello = await k.hello();
    assert.ok(
      hello.some((m) => m.type === 'tool' && m.id === 'c1'),
      'Postbox got the call while its record was written',
    );
    const replied = k.post('reply', { turn: 't1', id: 'c1', ok, text: ok ? 'Shown.' : 'Refused by Postbox.' });
    hold.release();
    await replied;
    return await got;
  } finally {
    await h.done();
  }
}

test('#827 a queued call Postbox took while its record was written still gets the daemon’s answer', async () => {
  assert.deepEqual(await answeredWhileRecording(), { type: 'result', id: 'c1', ok: true, text: QUEUED_TEXT });
});

test('#827 so does one Postbox refused meanwhile: Postbox tells its agent itself, at its next turn', async () => {
  assert.deepEqual(await answeredWhileRecording({ ok: false }), { type: 'result', id: 'c1', ok: true, text: QUEUED_TEXT });
});

test('#827 and one whose record failed after Postbox had taken it: it reached Postbox, so it was sent', async () => {
  assert.deepEqual(await answeredWhileRecording({ reject: true }), { type: 'result', id: 'c1', ok: true, text: QUEUED_TEXT });
});
