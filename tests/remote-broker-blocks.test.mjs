// The daemon’s broker (server/remote/host/broker-tools.mjs’s prepare, #120) and the blocks a host’s agent sends: what
// it checks before a call is queued for Postbox, and what it leaves to Postbox. Driven in-process, as
// tests/remote-broker.test.mjs drives it, with the fixtures in tests/remote-broker-fixtures.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostUpdateRefusal } from '../shared/block-updates.mjs';
import { connectShim, makeBroker, makeHome } from './remote-broker-fixtures.mjs';

test('#854 an outcome or a withdraw update_block from a host is queued for Postbox, as the laptop takes it', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const outcome = { id: 'pick', outcome: 'Filed as #1' };
    const withdraw = { id: 'pick', withdraw: 'The question is stale.' };
    assert.equal((await s.call('c1', 'update_block', { block: outcome })).ok, true);
    assert.equal((await s.call('c2', 'update_block', { block: withdraw })).ok, true);
    assert.deepEqual(
      k.sent.map((m) => [m.id, m.args.block]),
      [
        ['c1', outcome],
        ['c2', withdraw],
      ],
    );
    assert.doesNotMatch(k.logs.join('\n'), /was refused/);
  } finally {
    await h.done();
  }
});

test('an image update_block from a host is checked for https, and its origin is left to Postbox’s list', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const image = { id: 'img', type: 'image', version: 1, fallback: 'A cover', alt: 'A cover' };
    assert.equal((await s.call('c1', 'update_block', { block: { ...image, src: 'https://upload.wikimedia.org/a.png' } })).ok, true);
    const plain = await s.call('c2', 'update_block', { block: { ...image, src: 'http://upload.wikimedia.org/a.png' } });
    assert.match(plain.text, /^The update was invalid and wasn’t applied: src must be an https address/);
    assert.deepEqual(
      k.sent.map((m) => m.id),
      ['c1'],
    );
  } finally {
    await h.done();
  }
});

test('#827 the daemon refuses an invalid update_block in the same words as the shim, which refuses it in the call', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    // The shim refuses an invalid update before the daemon sees it (shim-calls.mjs, hostUpdateRefusal); one that
    // reaches the daemon, as a call carrying files does, must be refused in the same words.
    const block = { id: 'pick', type: 'choice', version: 1 };
    const r = await s.call('c1', 'update_block', { block });
    assert.equal(r.ok, false);
    assert.equal(r.text, hostUpdateRefusal(block));
  } finally {
    await h.done();
  }
});
