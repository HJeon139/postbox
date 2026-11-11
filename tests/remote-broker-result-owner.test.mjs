// #908 on the host: a tool call’s result goes only to the shim that made it (server/remote/host/broker-tools.mjs and
// broker-offline.mjs). Any client with a turn’s token can connect as one of its shims, so the daemon sends a result,
// live or answered offline, only on the connections whose key (the hello’s `shim`) made the call, and a connection
// that sends another shim’s call id again gets none of it. The rig is tests/remote-broker-fixtures.mjs.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, fakeClock, lines, makeBroker, makeHome, SHIM_KEY, sleep, turnToken, until } from './remote-broker-fixtures.mjs';
import { holdingIo, reached } from './remote-settle-io.mjs';

const OTHER = 'o'.repeat(32);
const SECRET = 'the private answer';
const results = (s, id = 'c1') => s.got.filter((m) => m.type === 'result' && m.id === id);
const hash = (key) => createHash('sha256').update(key).digest('hex');
const snapshot = (turn) => ({ turn, home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] });

/** A broker with turn t1, its shim (SHIM_KEY) and a bystander (another key), each welcomed. @param {any} h @param {object} [over] */
async function room(h, over = {}) {
  const k = makeBroker(h, over);
  await k.post('snapshot', snapshot('t1'));
  h.turn('t1');
  await k.b.starting('t1');
  const s = connectShim(k.b, 't1');
  const bystander = connectShim(k.b, 't1', turnToken('t1'), OTHER);
  await s.next('welcome');
  await bystander.next('welcome');
  return { k, s, bystander };
}

const sentTool = (k, id = 'c1') => until(() => k.sent.some((m) => m.type === 'tool' && m.id === id), `call ${id} sent to Postbox`);

test('#908 an asked call’s result reaches only the connections of the shim that made it', async () => {
  const h = makeHome();
  try {
    const { k, s, bystander } = await room(h);
    s.send('call', { id: 'c1', name: 'search_assets', args: { query: 'q' } });
    await sentTool(k);
    assert.deepEqual((await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: SECRET })).errors, []);
    assert.equal((await s.next('result', (m) => m.id === 'c1')).text, SECRET);
    await sleep(20);
    assert.deepEqual(results(bystander), [], 'the bystander got none of it');
  } finally {
    await h.done();
  }
});

/** The four ways a read is answered from the snapshot (designs/508/582/settle.md), each from a call shim `s` made. */
const OFFLINE = {
  'answered at once, with no Postbox attached': async ({ k, s }) => {
    k.state.attached = false;
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
  },
  'its 100 s deadline': async ({ k, s, clock }) => {
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await sentTool(k);
    await clock.tick(100_000);
  },
  'Postbox gone for good (driverLost)': async ({ k, s }) => {
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await sentTool(k);
    k.state.attached = false;
    k.b.driverLost();
  },
  'a hello past 100 s, after a daemon restart': async ({ h, k, s, clock }) => {
    await k.b.close(); // the first daemon is gone, so its own deadline doesn’t answer
    const again = makeBroker(h, { now: clock.now, timers: clock.timers });
    await again.b.load([{ turn: 't1', state: 'running' }]);
    const back = connectShim(again.b, 't1');
    const other = connectShim(again.b, 't1', turnToken('t1'), OTHER);
    await back.next('welcome');
    await other.next('welcome');
    s.close();
    await clock.tick(100_000);
    await again.hello();
    return { s: back, bystander: other };
  },
};

test('#908 a read answered from the snapshot reaches only its caller, whichever path answers it', async () => {
  for (const [how, answer] of Object.entries(OFFLINE)) {
    const h = makeHome();
    try {
      const clock = fakeClock();
      const r = await room(h, { now: clock.now, timers: clock.timers });
      if (how.startsWith('a hello')) {
        r.s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
        await sentTool(r.k);
      }
      const { s, bystander } = { ...r, ...(await answer({ h, clock, ...r })) };
      const got = await s.next('result', (m) => m.id === 'c1');
      assert.match(got.text, /x 0/, how);
      await sleep(20);
      assert.equal(results(s).length, 1, `${how}: the caller got it once`);
      assert.deepEqual(results(bystander), [], `${how}: the bystander got none of it`);
    } finally {
      await h.done();
    }
  }
});

test('#908 a connection that sends another shim’s call id again gets none of its result', async () => {
  const h = makeHome();
  try {
    const { k, s, bystander } = await room(h);
    s.send('call', { id: 'c1', name: 'search_assets', args: { query: 'q' } });
    await sentTool(k);
    await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: SECRET });
    await s.next('result', (m) => m.id === 'c1');
    const sent = k.sent.length;
    const got = await bystander.call('c1', 'search_assets', { query: 'something else' });
    assert.equal(got.ok, false, 'refused');
    assert.ok(!got.text.includes(SECRET), 'with none of the kept text');
    assert.match(got.text, /another connection/);
    assert.equal(k.sent.length, sent, 'nothing new reaches Postbox');
    // The shim that made it, on a new connection, still gets the kept answer.
    const back = connectShim(k.b, 't1');
    await back.next('welcome');
    assert.equal((await back.call('c1', 'search_assets', { query: 'q' })).text, SECRET);
  } finally {
    await h.done();
  }
});

test('#908 two shims racing on one call id: the second is refused, not answered', async () => {
  const h = makeHome();
  try {
    // The first call is held while it’s counted against the queue, so the second finds it taken (the 'again' path).
    const hold = holdingIo((c) => c.kind === 'stat');
    const { k, s, bystander } = await room(h, { io: hold.io });
    s.send('call', { id: 'c1', name: 'search_assets', args: { query: 'q' } });
    await reached(hold);
    bystander.send('call', { id: 'c1', name: 'search_assets', args: { query: 'q' } });
    await sleep(30);
    hold.release();
    const lost = await bystander.next('result', (m) => m.id === 'c1');
    assert.equal(lost.ok, false, 'the second is refused');
    assert.match(lost.text, /another connection/);
    await sentTool(k);
    await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: SECRET });
    assert.equal((await s.next('result', (m) => m.id === 'c1')).text, SECRET);
    await sleep(20);
    assert.ok(!results(bystander).some((m) => m.text === SECRET), 'the second never gets the answer');
  } finally {
    await h.done();
  }
});

test('#908 after its shim reconnects, a call’s result reaches the new connection', async () => {
  const h = makeHome();
  try {
    const { k, s } = await room(h);
    s.send('call', { id: 'c1', name: 'search_assets', args: { query: 'q' } });
    await sentTool(k);
    s.close();
    const back = connectShim(k.b, 't1');
    await back.next('welcome');
    await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: SECRET });
    assert.equal((await back.next('result', (m) => m.id === 'c1')).text, SECRET, 'without sending it again');
  } finally {
    await h.done();
  }
});

test('#908 after a daemon restart a call’s owner is read back: its shim gets the result, another key doesn’t', async () => {
  const h = makeHome();
  try {
    const { k, s } = await room(h);
    s.send('call', { id: 'c1', name: 'search_assets', args: { query: 'q' } });
    await sentTool(k);
    const path = h.p.turn('t1', TURN_FILES.tools);
    const [call] = lines(path).filter((r) => r.op === 'call');
    assert.equal(call.owner, hash(SHIM_KEY), 'the record names the shim by its key’s hash');
    assert.ok(!readFileSync(path, 'utf8').includes(SHIM_KEY), 'never by the key');
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    await again.hello();
    const back = connectShim(again.b, 't1');
    const other = connectShim(again.b, 't1', turnToken('t1'), OTHER);
    await back.next('welcome');
    await other.next('welcome');
    await again.post('reply', { turn: 't1', id: 'c1', ok: true, text: SECRET });
    assert.equal((await back.next('result', (m) => m.id === 'c1')).text, SECRET, 'live, to its shim');
    await sleep(20);
    assert.deepEqual(results(other), [], 'not to another key');
    const refused = await other.call('c1', 'search_assets', { query: 'q' });
    assert.equal(refused.ok, false);
    assert.ok(!refused.text.includes(SECRET), 'nor when it sends the id again');
  } finally {
    await h.done();
  }
});

test('#908 a call an older daemon wrote down goes to the first shim that sends it again, and stays its own after a restart', async () => {
  for (const owner of [undefined, 'not-a-hash']) {
    const h = makeHome();
    try {
      h.turn('t1');
      // As an older daemon wrote them: no owner (or one this daemon can’t read); c1’s reply kept, c2 still waiting.
      const call = (id) => ({ op: 'call', id, name: 'search_assets', route: 'ask', args: { query: 'q' }, at: 1, ...(owner ? { owner } : {}) });
      const reply = { op: 'reply', id: 'c1', ok: true, text: SECRET, at: 2 };
      writeFileSync(h.p.turn('t1', TURN_FILES.tools), `${[call('c1'), reply, call('c2')].map((r) => JSON.stringify(r)).join('\n')}\n`);
      const k = makeBroker(h);
      await k.b.load([{ turn: 't1', state: 'running' }]);
      const other = connectShim(k.b, 't1', turnToken('t1'), OTHER);
      await other.next('welcome');
      const s = connectShim(k.b, 't1');
      await s.next('welcome');
      // Postbox answers c2 before any shim has sent it again: nobody owns it yet, so nobody hears it.
      await k.hello();
      assert.deepEqual((await k.post('reply', { turn: 't1', id: 'c2', ok: true, text: SECRET })).errors, []);
      await sleep(20);
      assert.deepEqual([...results(other, 'c2'), ...results(s, 'c2')], [], `${owner ?? 'no owner'}: a live answer to an ownerless call reaches nobody`);
      assert.equal((await s.call('c2', 'search_assets', { query: 'q' })).text, SECRET, 'until its shim sends it again');
      assert.equal((await s.call('c1', 'search_assets', { query: 'q' })).text, SECRET, `${owner ?? 'no owner'}: the first to send it takes it`);
      assert.deepEqual(results(other), [], 'a bystander connected before it got nothing');
      assert.equal((await other.call('c1', 'search_assets', { query: 'q' })).ok, false, 'then another key is refused');
      const took = lines(h.p.turn('t1', TURN_FILES.tools)).filter((r) => r.op === 'owner' && r.id === 'c1');
      assert.deepEqual(
        took.map((r) => r.owner),
        [hash(SHIM_KEY)],
        'the take is written down, as the hash',
      );
      // A restart reads the take back: the call isn’t ownerless again.
      const again = makeBroker(h);
      await again.b.load([{ turn: 't1', state: 'running' }]);
      const late = connectShim(again.b, 't1', turnToken('t1'), OTHER);
      await late.next('welcome');
      const no = await late.call('c1', 'search_assets', { query: 'q' });
      assert.equal(no.ok, false, 'another key is refused after the restart');
      assert.ok(!no.text.includes(SECRET));
      const back = connectShim(again.b, 't1');
      await back.next('welcome');
      assert.equal((await back.call('c1', 'search_assets', { query: 'q' })).text, SECRET, 'its shim still gets it');
    } finally {
      await h.done();
    }
  }
});
