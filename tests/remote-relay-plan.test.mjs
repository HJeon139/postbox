// #759, after its pre-review: what the newer daemon’s own broker leaves to the older daemon, where Postbox’s first
// snapshot goes, a refused setting, and the relay ending once its turns stop. On the fake host in
// tests/remote-relay-fixture.mjs.

import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLineReader, encode, hostPaths, message, PROTOCOL_VERSION, TURN_FILES } from '../shared/remote-protocol.mjs';
import { BLOCK, REQUEST, sleep, TOKEN, until, VERSION } from './remote-broker-fixtures.mjs';
import { drive, host, OLD, postbox, welcomeOf } from './remote-relay-fixture.mjs';

const SNAPSHOT = { turn: 'ta', home: 'th', threads: [{ id: 'th', items: [{ id: 'i1', line: 'You: hi', text: 'You: hi' }] }] };

/**
 * A fake older daemon: each connection’s lines, parsed, and how it answers a hello.
 * @param {(hello: any) => any} answer  the frame for a hello, as [type, body]
 */
function fakeOlder(answer) {
  /** @type {any[][]} */
  const conns = [];
  /** @type {() => string} */
  let home = () => '/';
  const serveA = (/** @type {any} */ s) => {
    const heard = /** @type {any[]} */ ([]);
    conns.push(heard);
    const reader = createLineReader({
      onLine(line) {
        const m = JSON.parse(line);
        heard.push(m);
        if (m.type !== 'hello') return;
        const [type, body] = answer(m);
        if (type === 'welcome') s.write(encode(message('daemon-to-postbox', 'welcome', welcomeOf(home()))));
        else s.end(encode(message('daemon-to-postbox', type, body)));
      },
      onError: () => s.destroy(),
    });
    s.on('data', (/** @type {Buffer} */ b) => reader.push(b));
  };
  return { conns, serveA, setHome: (/** @type {string} */ h) => (home = () => h) };
}

test('#759: an old turn’s records the new daemon finds at its start stay the old daemon’s', async (t) => {
  const h = await host(t, {
    // A’s laptop is still on it, and A’s shim calls and asks: both are written down in the turn’s folder.
    async beforeB({ first, shim }) {
      shim.shimSend('call', { id: 'c1', name: 'show_block', args: { block: BLOCK } });
      shim.shimSend('permission', { id: 'p1', request: REQUEST });
      await first.msgs.next('tool');
      await first.msgs.next('prompt');
    },
  });
  const pb = await drive(h.b);
  await pb.msgs.next('relay');
  await sleep(30);
  assert.deepEqual(
    pb.msgs.messages.filter((m) => m.turn === 'ta').map((m) => m.type),
    ['relay'],
    'only the notice: A, busy with its own laptop, keeps the call and the prompt',
  );
});

test('#759: the snapshot Postbox sends once welcomed goes to the old daemon, after the relay’s hello', async (t) => {
  const older = fakeOlder(() => ['welcome']);
  const h = await host(t, { serveA: older.serveA });
  older.setHome(h.home);
  await h.first.hangUp();
  const pb = await drive(h.b);
  pb.send('snapshot', SNAPSHOT);
  await until(() => older.conns[0]?.some((m) => m.type === 'snapshot'), 'the snapshot at A');
  assert.deepEqual(
    older.conns[0].map((m) => m.type),
    ['hello', 'snapshot'],
  );
  assert.deepEqual(older.conns[0][1].threads, SNAPSHOT.threads);
});

test('#759: an old daemon that can’t read the relay’s settings gets its hello again without them, and the snapshot', async (t) => {
  const older = fakeOlder((hello) =>
    hello.settings ? ['error', { code: 'bad-message', message: 'hello.settings has a field “newSetting” it doesn’t know.' }] : ['welcome'],
  );
  const h = await host(t, { serveA: older.serveA });
  older.setHome(h.home);
  await h.first.hangUp();
  const pb = postbox(h.b);
  pb.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, instance: 'laptop-after'.padEnd(32, '0'), settings: { permissionWaitMax: 60_000 } });
  await pb.msgs.next('welcome');
  pb.send('snapshot', SNAPSHOT);
  await until(() => older.conns[1]?.some((m) => m.type === 'snapshot'), 'the snapshot, on the second hello');
  assert.deepEqual(older.conns[0][0].settings, { permissionWaitMax: 60_000 }, 'the first hello carried them');
  assert.ok(!Object.hasOwn(older.conns[1][0], 'settings'), 'the second didn’t');
  await sleep(20);
  assert.ok(!pb.msgs.messages.some((m) => m.type === 'relay'), 'relayed, so no notice');
});

test('#759: a relay ends once its turn no longer runs, though Postbox doesn’t read it, so the old daemon can idle out', async (t) => {
  const h = await host(t, { relayCheckMs: 20 });
  await h.first.hangUp();
  const pb = await drive(h.b);
  await until(() => h.sockets.size === 1, 'the relay');
  const [side] = h.sockets;
  await sleep(60);
  assert.equal(side.readableEnded, false, 'up while the turn runs');
  // The turn ends as a runner ends one: its exit.json, then its runner gone.
  writeFileSync(hostPaths(h.home, VERSION).turn('ta', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
  h.alive.delete('ta');
  await until(() => side.readableEnded, 'the relay to end');
  assert.ok(!pb.msgs.messages.some((m) => m.type === 'relay'), 'quietly: the turn is over');
});

test('#759: Postbox’s lines wait for the old daemon’s welcome, so one it can’t read isn’t taken for a refused hello', async (t) => {
  /** @type {any[]} */
  const heard = [];
  /** @type {any} */
  let h;
  h = await host(t, {
    // As daemon-conn.mjs does: a line it can’t read is refused at once, with no re and no turn, while the hello waits.
    serveA(s) {
      let welcomed = false;
      const reader = createLineReader({
        onLine(line) {
          const m = JSON.parse(line);
          heard.push(m);
          if (m.type === 'hello')
            setTimeout(() => {
              welcomed = true;
              s.write(encode(message('daemon-to-postbox', 'welcome', welcomeOf(h.home))));
            }, 30);
          else if (!welcomed) s.write(`${JSON.stringify({ type: 'error', code: 'bad-message', message: 'A field it doesn’t know.' })}\n`);
        },
        onError: () => s.destroy(),
      });
      s.on('data', (/** @type {Buffer} */ b) => reader.push(b));
    },
  });
  await h.first.hangUp();
  const pb = await drive(h.b);
  pb.send('snapshot', SNAPSHOT);
  await until(() => heard.some((m) => m.type === 'snapshot'), 'the snapshot at A');
  await sleep(20);
  assert.deepEqual(
    heard.map((m) => m.type),
    ['hello', 'snapshot'],
  );
  assert.ok(!pb.msgs.messages.some((m) => m.type === 'relay'), 'relayed, so no notice');
});

test('#759: a frame from the old daemon this one can’t read marks its turn lost, once', async (t) => {
  /** @type {any} */
  let older = null;
  const h = await host(t, {
    serveA(s) {
      older = s;
      s.once('data', () => s.write(encode(message('daemon-to-postbox', 'welcome', welcomeOf(h.home)))));
    },
  });
  await h.first.hangUp();
  const pb = await drive(h.b);
  await until(() => older, 'the relay’s connection');
  await sleep(20);
  // A tool frame from a version whose tool carries a field this one doesn’t know.
  const frame = `${JSON.stringify({ type: 'tool', turn: 'ta', id: 'c1', name: 'show_block', args: { block: BLOCK }, newField: 1 })}\n`;
  older.write(frame);
  older.write(frame);
  assert.deepEqual(await pb.msgs.next('relay'), { type: 'relay', turn: 'ta', version: OLD, state: 'lost' });
  await sleep(30);
  assert.equal(pb.msgs.messages.filter((m) => m.type === 'relay').length, 1, 'once');
  assert.ok(!pb.msgs.messages.some((m) => m.type === 'tool'));
});

test('#759: a scan that can’t read the turn folders doesn’t end a relay whose turn still runs', async (t) => {
  const h = await host(t, { relayCheckMs: 20 });
  await h.first.hangUp();
  await drive(h.b);
  await until(() => h.sockets.size === 1, 'the relay');
  const [side] = h.sockets;
  const turns = hostPaths(h.home, VERSION).turns;
  chmodSync(turns, 0o000);
  try {
    await sleep(80);
  } finally {
    chmodSync(turns, 0o700);
  }
  await sleep(40);
  assert.equal(side.readableEnded, false, 'still relayed');
});
