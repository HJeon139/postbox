// Tests for the remote read contract (#530, CX-2): Protocol 3 handshake, tool routing,
// online reading via Postbox, offline reading from snapshot with notice, repeat behavior,
// and reconnect resilience during in-flight and resent reads.

import assert from 'node:assert/strict';
import test from 'node:test';
import { SshFailure } from '../server/remote/ssh.mjs';
import { encode, message, PROTOCOL_VERSION, TOOL_ROUTES } from '../shared/remote-protocol.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { connectShim, makeBroker, makeHome, until } from './remote-broker-fixtures.mjs';
import { connection } from './remote-ssh-fixtures.mjs';

// ── 1. Protocol version and tool routing ─────────────────────────────────────────────

test('PROTOCOL_VERSION is 3 and TOOL_ROUTES routes reads as read', () => {
  assert.equal(PROTOCOL_VERSION, 3);
  assert.equal(TOOL_ROUTES.read_conversation, 'read');
  assert.equal(TOOL_ROUTES.read_message, 'read');
});

// ── 2. Handshake and version mismatch (CX-2, #464) ───────────────────────────────────

test('v2-against-v3 handshake: v3 Postbox refuses a v2 daemon welcome with actionable resolution', async () => {
  const welcome = message('daemon-to-postbox', 'welcome', {
    version: 2,
    home: '/home/user',
    node: { path: '/usr/bin/node', version: 'v22.12.0' },
    harnesses: [],
    problems: [],
    turns: [],
  });
  const ssh = fakeSsh({ script: (child) => child.stdout.write(encode(welcome)) });
  const failure = await connection({ spawn: ssh.spawn })
    .connect()
    .catch((e) => e);
  assert.ok(failure instanceof SshFailure);
  assert.equal(failure.kind, 'version');
  assert.equal(failure.retry, false);
  assert.match(failure.message, /It speaks protocol 2; this Postbox speaks 3\./);
  assert.match(failure.next, /^Install this Postbox’s version on host\.example\.com from the host’s settings, then reconnect\./);
});

test('v2-against-v3 handshake: v3 daemon refuses a v2 Postbox hello with actionable error', async () => {
  const { hello } = await import('../server/remote/host/daemon-hello.mjs');
  let output = '';
  const c = {
    closed: false,
    output: {
      write: (d) => {
        output += d;
        return true;
      },
    },
  };
  await hello(/** @type {any} */ ({}), /** @type {any} */ (c), { version: 2 });
  const msg = JSON.parse(output.trim());
  assert.equal(msg.type, 'error');
  assert.equal(msg.code, 'version');
  assert.match(msg.message, /This host’s daemon speaks protocol 3, and Postbox sent 2\./);
});

test('resending an already-answered read while detached returns kept live answer, not offline fallback', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const snap = { turn: 't_s1', home: 'th', threads: [{ id: 'th', items: [{ id: 'item_1', line: 'Item 1 line', text: 'Stale snapshot' }] }] };
    await k.post('snapshot', snap);
    h.turn('t_s1');
    await k.b.starting('t_s1');
    const s = connectShim(k.b, 't_s1');
    await s.next('welcome');

    // 1. Attached read call answered by Postbox.
    const callPromise = s.call('c_live', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c_live'), 'tool sent to Postbox', 250);
    await k.post('reply', { turn: 't_s1', id: 'c_live', ok: true, text: 'Live Postbox answer' });
    const liveRes = await callPromise;
    assert.equal(liveRes.text, 'Live Postbox answer');

    // 2. Link drops.
    k.state.attached = false;

    // 3. Resending while detached must return the kept live answer, not the stale snapshot with offline disclaimer.
    const resentRes = await s.call('c_live', 'read_message', { id: 'item_1' });
    assert.equal(resentRes.ok, true);
    assert.equal(resentRes.text, 'Live Postbox answer');
    assert.doesNotMatch(resentRes.text, /Read offline/);
  } finally {
    h.done();
  }
});

// ── 3. Online reads always ask Postbox (CX-2) ─────────────────────────────────────────

test('connected read_message asks Postbox rather than reading locally', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const snap = {
      turn: 't1',
      home: 'th',
      threads: [{ id: 'th', items: [{ id: 'item_1', line: 'Pending review', text: 'Original draft', blockId: 'rev_1' }] }],
    };
    await k.post('snapshot', snap);
    h.turn('t1');
    await k.b.starting('t1');
    const s = connectShim(k.b, 't1');
    await s.next('welcome');

    const callPromise = s.call('c1', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.name === 'read_message'), 'read_message forwarded to Postbox', 250);
    const sentTool = k.sent.find((m) => m.type === 'tool' && m.name === 'read_message');
    assert.deepEqual(sentTool.args, { id: 'item_1' });

    await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: 'Approved: review approved with 0 comments.' });
    const res = await callPromise;
    assert.equal(res.ok, true);
    assert.equal(res.text, 'Approved: review approved with 0 comments.');
  } finally {
    h.done();
  }
});

test('connected read_conversation queries Postbox and reaches items earlier than snapshot window', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const snap = { turn: 't2', home: 'th', threads: [{ id: 'th', items: [{ id: 'item_50', line: 'line 50', text: 'text 50' }] }] };
    await k.post('snapshot', snap);
    h.turn('t2');
    await k.b.starting('t2');
    const s = connectShim(k.b, 't2');
    await s.next('welcome');

    const callPromise = s.call('c2', 'read_conversation', { skip: 50, limit: 10 });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.name === 'read_conversation'), 'read_conversation forwarded to Postbox', 250);
    const sentTool = k.sent.find((m) => m.type === 'tool' && m.name === 'read_conversation');
    assert.deepEqual(sentTool.args, { skip: 50, limit: 10 });

    await k.post('reply', { turn: 't2', id: 'c2', ok: true, text: '[item_0] First message\n\n[item_1] Second message' });
    const res = await callPromise;
    assert.equal(res.ok, true);
    assert.match(res.text, /First message/);
  } finally {
    h.done();
  }
});

// ── 4. Offline reads fall back to snapshot with notice (CX-2) ────────────────────────

test('disconnected read_message falls back to snapshot.json with offline notice', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const snap = { turn: 't3', home: 'th', threads: [{ id: 'th', items: [{ id: 'item_offline', line: 'line', text: 'offline content' }] }] };
    await k.post('snapshot', snap);
    h.turn('t3');
    await k.b.starting('t3');
    k.state.attached = false;

    const s = connectShim(k.b, 't3');
    await s.next('welcome');
    const res = await s.call('c3', 'read_message', { id: 'item_offline' });
    assert.equal(res.ok, true);
    assert.match(res.text, /^offline content/);
    assert.match(res.text, /\(Read offline as of this turn’s start; earlier or changed items may be missing\.\)$/);
    assert.equal(k.sent.length, 0, 'no calls sent to Postbox while offline');
  } finally {
    h.done();
  }
});

test('disconnected read_conversation falls back to snapshot.json with offline notice', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const snap = { turn: 't4', home: 'th', threads: [{ id: 'th', items: [{ id: 'item_1', line: 'Item one', text: 'Text one' }] }] };
    await k.post('snapshot', snap);
    h.turn('t4');
    await k.b.starting('t4');
    k.state.attached = false;

    const s = connectShim(k.b, 't4');
    await s.next('welcome');
    const res = await s.call('c4', 'read_conversation', {});
    assert.equal(res.ok, true);
    assert.match(res.text, /\[item_1\] Item one/);
    assert.match(res.text, /\(Read offline as of this turn’s start; earlier or changed items may be missing\.\)$/);
  } finally {
    h.done();
  }
});

test('late reply: read sent to Postbox, link drops, shim resends offline, and reconnect reply does not duplicate result', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const snap = { turn: 't_late', home: 'th', threads: [{ id: 'th', items: [{ id: 'item_1', line: 'Item 1 line', text: 'Item 1 snapshot' }] }] };
    await k.post('snapshot', snap);
    h.turn('t_late');
    await k.b.starting('t_late');
    const s = connectShim(k.b, 't_late');
    await s.next('welcome');

    // 1. Shim sends read call while attached; broker forwards to Postbox.
    s.send('call', { id: 'call_late', name: 'read_message', args: { id: 'item_1' } });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_late'), 'tool sent to Postbox', 250);

    // 2. Link drops before Postbox replies.
    k.state.attached = false;

    // 3. Shim resends while offline; receives snapshot result with offline notice.
    const offlineRes = await s.call('call_late', 'read_message', { id: 'item_1' });
    assert.equal(offlineRes.ok, true);
    assert.match(offlineRes.text, /Item 1 snapshot/);
    assert.match(offlineRes.text, /\(Read offline as of this turn’s start; earlier or changed items may be missing\.\)$/);

    // 4. Link reconnects and Postbox replies to the original tool call.
    k.state.attached = true;
    await k.post('reply', { turn: 't_late', id: 'call_late', ok: true, text: 'Item 1 live from Postbox' });

    // 5. Shim must NOT receive a duplicate result for call_late.
    const second = await s.next('result', 100).catch(() => null);
    assert.equal(second, null, 'shim did not receive a duplicate result from Postbox reply');
  } finally {
    h.done();
  }
});

test('pending read when link drops without resend answers when link reconnects', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const snap = { turn: 't_pending', home: 'th', threads: [{ id: 'th', items: [{ id: 'item_1', line: 'Item 1 line', text: 'Item 1 text' }] }] };
    await k.post('snapshot', snap);
    h.turn('t_pending');
    await k.b.starting('t_pending');
    const s = connectShim(k.b, 't_pending');
    await s.next('welcome');

    // 1. Shim calls while attached.
    const callPromise = s.call('call_pend', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_pend'), 'tool sent to Postbox', 250);

    // 2. Link drops; shim does not resend, stays waiting on socket.
    k.state.attached = false;

    // 3. Link reconnects and Postbox replies.
    k.state.attached = true;
    await k.post('reply', { turn: 't_pending', id: 'call_pend', ok: true, text: 'Live answer from Postbox' });

    // 4. Shim receives the result now that link is restored.
    const res = await callPromise;
    assert.equal(res.ok, true);
    assert.equal(res.text, 'Live answer from Postbox');
  } finally {
    h.done();
  }
});

// ── 5. Repeatable reads after dropped link (CX-2) ────────────────────────────────────

test('read calls over 2,000 chars are repeatable and not truncated on retry', async () => {
  const { onTool } = await import('../server/remote/turns-tools.mjs');
  const fullText = 'A'.repeat(3000);
  const replies = [];
  const link = {
    send: (msg) => {
      replies.push(msg);
      return true;
    },
  };
  const session = { id: 's1', remoteTurn: { replies: [] } };
  const rt = {
    s: { sessions: { s1: session } },
    updateSession: (_id, patch) => Object.assign(session, patch),
    toolsFor: () => ({ read_message: () => ({ ok: true, message: fullText }) }),
  };
  const rts = {
    rt,
    byTurn: new Map([['t_repeat', { sessionId: 's1', rt: { closed: false } }]]),
    needed: new Map([['host_1', { link }]]),
    applying: new Set(),
    now: () => 1000,
  };

  await onTool(/** @type {any} */ (rts), 'host_1', { turn: 't_repeat', id: 'call_long', name: 'read_message', args: { id: 'it_1' } });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text.length, 3000);
  assert.equal(
    session.remoteTurn.replies.some((r) => r.id === 'call_long'),
    false,
    'repeatable reads not cached in remoteTurn.replies',
  );
});
