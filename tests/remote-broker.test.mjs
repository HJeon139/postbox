// The daemon’s broker (server/remote/host/broker.mjs, #120), driven in-process: a shim’s hello, and its queued and
// asked calls. A shim is a pair of functions, Postbox is a list of what the broker sent it, and the turn folders are in
// a temp home (tests/remote-broker-fixtures.mjs). Nothing is spawned; the real daemon, runner and shim are in
// tests/integration/remote-broker.test.mjs.

import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { test } from 'node:test';
import { STOPPED_TEXT } from '../server/remote/host/broker.mjs';
import { HOST_DEFAULTS, TURN_FILES } from '../shared/remote-protocol.mjs';
import { BLOCK, connectShim, lines, makeBroker, makeHome, TOKEN, turnToken, until } from './remote-broker-fixtures.mjs';

// ── Shim connections ──

test('a shim’s hello: the token, then the turn; unknown, ended and stopping turns are refused', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    h.turn('t2');
    writeFileSync(h.p.turn('t2', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
    const k = makeBroker(h, { settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: 120_000 }) });
    const ok = connectShim(k.b, 't1');
    assert.deepEqual(await ok.next('welcome'), { type: 'welcome', turn: 't1', permissionWaitMax: 120_000 });
    const bad = connectShim(k.b, 't1', 'c'.repeat(64));
    assert.equal((await bad.next('error')).code, 'bad-token');
    assert.ok(bad.ended, 'a refused shim’s connection is closed');
    // The host’s token is no longer a shim’s: each turn has its own, and one turn’s doesn’t open another (#120).
    assert.equal((await connectShim(k.b, 't1', TOKEN).next('error')).code, 'bad-token');
    assert.equal((await connectShim(k.b, 't2', turnToken('t1')).next('error')).code, 'bad-token');
    // A turn with no folder has no token to match, so nothing about it is said.
    assert.equal((await connectShim(k.b, 'nope').next('error')).code, 'bad-token');
    const over = await connectShim(k.b, 't2').next('error');
    assert.deepEqual([over.code, over.message], ['turn-ended', STOPPED_TEXT]);
    await k.b.stopping('t1');
    assert.equal((await ok.next('error')).code, 'turn-ended', 'a connected shim hears its turn is stopping');
    assert.equal((await connectShim(k.b, 't1').next('error')).code, 'turn-ended');
    // A call after Stop is refused, as the laptop refuses one (#126), and nothing reaches Postbox.
    const r = await ok.call('c1', 'show_block', { block: BLOCK });
    assert.deepEqual([r.ok, r.text], [false, STOPPED_TEXT]);
    assert.deepEqual(k.sent, []);
    assert.deepEqual(
      lines(h.p.turn('t1', TURN_FILES.tools)).map((x) => x.op),
      ['stopping'],
      'stopping is recorded, and the call isn’t',
    );
    // It outlives a restart.
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    assert.equal((await connectShim(again.b, 't1').next('error')).code, 'turn-ended');
  } finally {
    h.done();
  }
});

// ── Queued calls ──

test('a queued call is recorded, answered at once, sent to Postbox, and dropped when Postbox replies', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const r = await s.call('c1', 'show_block', { block: BLOCK });
    assert.equal(r.ok, true);
    assert.deepEqual(
      lines(h.p.turn('t1', TURN_FILES.tools)).map((x) => [x.op, x.id, x.name]),
      [['call', 'c1', 'show_block']],
      'on disk before the shim heard',
    );
    assert.equal(statSync(h.p.turn('t1', TURN_FILES.tools)).mode & 0o777, 0o600);
    assert.deepEqual(k.sent, [{ type: 'tool', turn: 't1', id: 'c1', name: 'show_block', args: { block: BLOCK } }]);
    // Resent after a reconnect, with the same ID: answered again, never queued twice.
    const s2 = connectShim(k.b, 't1');
    await s2.next('welcome');
    assert.equal((await s2.call('c1', 'show_block', { block: BLOCK })).ok, true);
    assert.equal(k.sent.length, 1);
    // Another turn may use the same ID: (turn, id) is the identity.
    h.turn('t2');
    const o = connectShim(k.b, 't2');
    await o.next('welcome');
    await o.call('c1', 'define_term', { term: 'x', definition: 'y' });
    assert.equal(k.sent.length, 2);
    // Each hello sends what Postbox hasn’t replied to.
    assert.deepEqual(
      (await k.hello()).map((m) => [m.turn, m.id]),
      [
        ['t1', 'c1'],
        ['t2', 'c1'],
      ],
    );
    assert.deepEqual((await k.post('reply', { turn: 't1', id: 'c1', ok: false, text: 'Block pick is already shown.' })).errors, []);
    assert.match(k.logs.join('\n'), /refused turn t1’s show_block \(c1\): Block pick is already shown/);
    assert.deepEqual(
      (await k.hello()).map((m) => [m.turn, m.id]),
      [['t2', 'c1']],
    );
    assert.equal((await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: 'x' })).errors[0].code, 'no-tool', 'a reply goes once');
    assert.equal((await k.post('reply', { turn: 't1', id: 'zz', ok: true, text: 'x' })).errors[0].code, 'no-tool');
    assert.equal(s.got.filter((m) => m.type === 'result').length, 1, 'nothing more reached the shim');
  } finally {
    h.done();
  }
});

test('a queued call while Postbox is away waits, and crosses at its hello; it outlives a daemon restart', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    k.state.attached = false;
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    assert.equal((await s.call('c1', 'schedule_wake', { in_minutes: 5 })).ok, true, 'the shim is answered while Postbox is away');
    assert.equal((await s.call('c2', 'wake_agent', { handle: 'reviewer', message: 'hi' })).ok, true);
    assert.deepEqual(k.sent, []);
    k.state.attached = true;
    await k.post('reply', { turn: 't1', id: 'c2', ok: true, text: 'Woken.' }); // a reply before the hello is still a reply
    // A new daemon, from the records on disk.
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(
      (await again.hello()).map((m) => [m.type, m.id, m.name, m.args]),
      [['tool', 'c1', 'schedule_wake', { in_minutes: 5 }]],
    );
    // The shim, reconnecting, sends c1 again: recognized from the records, so it isn’t sent a second time.
    const s2 = connectShim(again.b, 't1');
    await s2.next('welcome');
    assert.equal((await s2.call('c1', 'schedule_wake', { in_minutes: 5 })).ok, true);
    assert.deepEqual(again.sent, []);
    // A torn last line, as a crash mid-append leaves, is skipped.
    await appendFile(h.p.turn('t1', TURN_FILES.tools), '{"op":"call","id":"c3"');
    const third = makeBroker(h);
    await third.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(
      (await third.hello()).map((m) => m.id),
      ['c1'],
    );
  } finally {
    h.done();
  }
});

test('calls waiting for Postbox stop at the host’s limits: so many, so many bytes, and the turn’s record of them', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h, { queueLimits: { calls: 2, bytes: 1_000_000, recordBytes: 1_000_000 } });
    k.state.attached = false;
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    assert.equal((await s.call('c1', 'schedule_wake', { in_minutes: 5 })).ok, true);
    assert.equal((await s.call('c2', 'schedule_wake', { in_minutes: 6 })).ok, true);
    const third = await s.call('c3', 'schedule_wake', { in_minutes: 7 });
    assert.equal(third.ok, false, 'a third waiting call is over the limit of 2');
    assert.match(third.text, /already has 2 calls .* waiting for Postbox/);
    // Once Postbox has taken them, there’s room again.
    k.state.attached = true;
    await k.hello();
    for (const id of ['c1', 'c2']) await k.post('reply', { turn: 't1', id, ok: true, text: 'Done.' });
    assert.equal((await s.call('c3', 'schedule_wake', { in_minutes: 7 })).ok, true);
    // One too large for what’s left of the bytes, and then for the turn’s record.
    const small = makeBroker(h, { queueLimits: { calls: 10, bytes: 600, recordBytes: 1_000_000 } });
    small.state.attached = false;
    const s2 = connectShim(small.b, 't1');
    await s2.next('welcome');
    const big = await s2.call('c4', 'wake_agent', { handle: 'reviewer', message: 'x'.repeat(500) });
    assert.match(big.text, /waiting for Postbox, as many as this host keeps/);
    const full = makeBroker(h, { queueLimits: { calls: 10, bytes: 1_000_000, recordBytes: 100 } });
    const s3 = connectShim(full.b, 't1');
    await s3.next('welcome');
    assert.match((await s3.call('c5', 'schedule_wake', { in_minutes: 8 })).text, /record of its calls on this host has reached/);
  } finally {
    h.done();
  }
});

test('two shims of a turn sending at once can’t pass the limit on calls waiting together', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h, { queueLimits: { calls: 1, bytes: 1_000_000, recordBytes: 1_000_000 } });
    k.state.attached = false;
    const s1 = connectShim(k.b, 't1');
    const s2 = connectShim(k.b, 't1');
    await Promise.all([s1.next('welcome'), s2.next('welcome')]);
    const got = await Promise.all([s1.call('c1', 'schedule_wake', { in_minutes: 5 }), s2.call('c2', 'schedule_wake', { in_minutes: 6 })]);
    assert.deepEqual(got.map((r) => r.ok).sort(), [false, true], 'exactly one queued');
    assert.equal(lines(h.p.turn('t1', TURN_FILES.tools)).filter((x) => x.op === 'call').length, 1, 'and only it recorded');
  } finally {
    h.done();
  }
});

test('show_block and update_block are checked with the catalog first, as the laptop refuses an invalid block (#455)', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const bad = await s.call('c1', 'update_block', { block: { id: 'pick', type: 'choice', version: 1 } });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /^The update was invalid and wasn’t applied: /);
    assert.match(k.logs.join('\n'), /update_block \(c1\) was refused/);
    const shown = await s.call('c2', 'show_block', { block: { type: 'nope' } });
    assert.equal(shown.ok, false);
    assert.match(shown.text, /^The block wasn’t shown, and the person sees nothing yet: /);
    assert.deepEqual(k.sent, [], 'neither reached Postbox');
  } finally {
    h.done();
  }
});

// ── Asked calls ──

test('an asked call: refused at once with no Postbox, else Postbox’s reply is the result; add_dataset isn’t supported yet', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    k.state.attached = false;
    const away = await s.call('c1', 'corpus_search', { query: 'x' });
    assert.equal(away.ok, false);
    assert.match(away.text, /^Postbox isn’t connected to this host right now, so corpus_search can’t run/);
    assert.equal((await k.hello()).length, 0, 'a refused call isn’t queued');
    k.state.attached = true;
    s.send('call', { id: 'c2', name: 'corpus_search', args: { query: 'y' } });
    await until(() => k.sent.length, 'the tool');
    assert.deepEqual(k.sent[0], { type: 'tool', turn: 't1', id: 'c2', name: 'corpus_search', args: { query: 'y' } });
    await k.post('reply', { turn: 't1', id: 'c2', ok: true, text: '[{"id":"b:1"}]' });
    assert.deepEqual(await s.next('result', (m) => m.id === 'c2'), { type: 'result', id: 'c2', ok: true, text: '[{"id":"b:1"}]' });
    // A shim that missed it gets it when it asks again.
    const s2 = connectShim(k.b, 't1');
    await s2.next('welcome');
    assert.equal((await s2.call('c2', 'corpus_search', { query: 'y' })).text, '[{"id":"b:1"}]');
    assert.equal(k.sent.length, 1);
    const ds = await s.call('c3', 'add_dataset', { id: 'd', path: 'd.jsonl' });
    assert.equal(ds.ok, false);
    assert.match(ds.text, /^Loading a dataset isn’t supported yet for an agent on a remote host/);
    assert.equal(k.sent.length, 1);
  } finally {
    h.done();
  }
});

test('an asked call’s answer outlives a daemon restart: the shim resending it gets Postbox’s reply, not silence', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('call', { id: 'c1', name: 'corpus_search', args: { query: 'y' } });
    await until(() => k.sent.length, 'the tool');
    // The reply comes while the shim is away, then the daemon restarts before it reconnects.
    s.close();
    await k.post('reply', { turn: 't1', id: 'c1', ok: false, text: 'No book is called “x”.' });
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    const s2 = connectShim(again.b, 't1');
    await s2.next('welcome');
    assert.deepEqual(await s2.call('c1', 'corpus_search', { query: 'y' }), { type: 'result', id: 'c1', ok: false, text: 'No book is called “x”.' });
    assert.deepEqual([again.sent, await again.hello()], [[], []], 'an answered call isn’t sent to Postbox again');
  } finally {
    h.done();
  }
});
