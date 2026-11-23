// #759, after critic’s review: nothing a relay carries is dropped without a word, the socket check of the design’s
// point 3, and the ways a relay ends. On the fake host in tests/remote-relay-fixture.mjs.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { createLineReader, encode, hostPaths, message, TURN_FILES } from '../shared/remote-protocol.mjs';
import { BLOCK, sleep, until, VERSION } from './remote-broker-fixtures.mjs';
import { ALLOW, drive, host, OLD, welcomeOf } from './remote-relay-fixture.mjs';

/** Postbox’s answer for A’s turn, for a prompt id. @param {string} prompt */
const answer = (prompt) => ({ turn: 'ta', prompt, result: ALLOW });

/**
 * A fake older daemon: what each of its connections heard, and what it does with each line.
 * @param {(m: any, s: any) => void} onLine
 */
function fakeOlder(onLine) {
  /** @type {any[]} */
  const heard = [];
  const serveA = (/** @type {any} */ s) => {
    const reader = createLineReader({
      onLine(line) {
        const m = JSON.parse(line);
        heard.push(m);
        onLine(m, s);
      },
      onError: () => s.destroy(),
    });
    s.on('data', (/** @type {Buffer} */ b) => reader.push(b));
  };
  return { heard, serveA };
}

test('#759: a line the old daemon refuses after its welcome ends the relay, lost', async (t) => {
  /** @type {any} */
  let h;
  const older = fakeOlder((m, s) => {
    if (m.type === 'hello') s.write(encode(message('daemon-to-postbox', 'welcome', welcomeOf(h.home))));
    // As daemon-conn.mjs refuses a line it can’t read: no turn, no re.
    else s.write(`${JSON.stringify({ type: 'error', code: 'bad-message', message: 'answer has a field it doesn’t know.' })}\n`);
  });
  h = await host(t, { serveA: older.serveA });
  await h.first.hangUp();
  const pb = await drive(h.b);
  await until(() => older.heard.some((m) => m.type === 'hello'), 'the relay’s hello');
  pb.send('answer', answer('p1'));
  pb.send('answer', answer('p2'));
  assert.deepEqual(await pb.msgs.next('relay'), { type: 'relay', turn: 'ta', version: OLD, state: 'lost' });
  const [side] = h.sockets;
  await until(() => side.readableEnded, 'the relay to end');
  await sleep(20);
  assert.equal(pb.msgs.messages.filter((m) => m.type === 'relay').length, 1, 'once');
  assert.ok(
    h.logs.some((l) => l.includes('refused a line from a relay: bad-message')),
    h.logs.join('\n'),
  );
});

for (const [held, state] of /** @type {const} */ ([
  [false, 'off'],
  [true, 'lost'],
]))
  test(`#759: an old daemon that never welcomes the relay leaves the turn ${state}, ${held ? 'its held answer gone' : 'nothing held'}`, async (t) => {
    const older = fakeOlder(() => {});
    const h = await host(t, { serveA: older.serveA, relayWelcomeMs: 50 });
    await h.first.hangUp();
    const pb = await drive(h.b);
    if (held) pb.send('answer', answer('p1'));
    assert.deepEqual(await pb.msgs.next('relay'), { type: 'relay', turn: 'ta', version: OLD, state });
    assert.ok(!older.heard.some((m) => m.type === 'answer'), 'nothing but the hello went before a welcome');
    assert.ok(
      h.logs.some((l) => l.includes('didn’t welcome a relay')),
      h.logs.join('\n'),
    );
  });

test('#759: a relay that can hold no more of Postbox’s lines before a welcome ends with its notice', async (t) => {
  const older = fakeOlder(() => {});
  const h = await host(t, { serveA: older.serveA });
  await h.first.hangUp();
  const pb = await drive(h.b);
  for (let i = 0; i <= 1000; i++) pb.send('answer', answer(`p${i}`));
  // The answers it held are gone, so Postbox may wait on them: lost.
  assert.deepEqual(await pb.msgs.next('relay'), { type: 'relay', turn: 'ta', version: OLD, state: 'lost' });
  assert.ok(
    h.logs.some((l) => l.includes('held 1000 lines with no welcome')),
    h.logs.join('\n'),
  );
});

for (const [what, placeSocket] of /** @type {[string, (path: string, home: string) => (() => void) | void][]} */ ([
  ['a regular file', (path) => writeFileSync(path, '')],
  [
    'a link to a socket outside ~/.postbox-remote',
    (path, home) => {
      const outside = join(home, 'elsewhere');
      mkdirSync(outside);
      const server = createServer((s) => s.destroy()).listen(join(outside, 's.sock'));
      symlinkSync(join(outside, 's.sock'), path);
      return () => server.close();
    },
  ],
  [
    'a socket in a version folder that links outside ~/.postbox-remote',
    (path, home) => {
      // The socket itself is one, so only the folder’s real path tells it isn’t the account’s own.
      const outside = join(home, 'elsewhere');
      mkdirSync(outside);
      rmdirSync(dirname(path));
      symlinkSync(outside, dirname(path));
      const server = createServer((s) => s.destroy()).listen(join(outside, basename(path)));
      return () => server.close();
    },
  ],
])) {
  test(`#759: B never connects when A’s socket path is ${what}`, async (t) => {
    const h = await host(t, { placeSocket });
    await h.first.hangUp();
    const pb = await drive(h.b);
    assert.deepEqual(await pb.msgs.next('relay'), { type: 'relay', turn: 'ta', version: OLD, state: 'off' });
    assert.equal(h.sockets.size, 0, 'no connection');
  });
}

test('#759: a relay ends with its driver', async (t) => {
  const h = await host(t);
  await h.first.hangUp();
  const pb = await drive(h.b);
  await until(() => h.sockets.size === 1, 'the relay');
  const [side] = h.sockets;
  await pb.hangUp();
  await until(() => side.readableEnded, 'the relay to end');
});

test('#759: a relay ends when Postbox, reading its turn, sees the turn end', async (t) => {
  const h = await host(t);
  await h.first.hangUp();
  const pb = await drive(h.b);
  await until(() => h.sockets.size === 1, 'the relay');
  const [side] = h.sockets;
  pb.send('read', { turn: 'ta', from: 0 });
  await pb.msgs.next('caught-up');
  writeFileSync(hostPaths(h.home, VERSION).turn('ta', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
  h.alive.delete('ta');
  await pb.msgs.next('ended');
  // The relay’s own look at its turns comes every 30 s by default: the turn’s end closed it first.
  await until(() => side.readableEnded, 'the relay to end');
});

/** No relay opened, and no notice: B left the turn alone. @param {any} h @param {any} pb */
async function untouched(h, pb) {
  await sleep(40);
  assert.equal(h.sockets.size, 0, 'no connection to A');
  assert.ok(!pb.msgs.messages.some((/** @type {any} */ m) => m.type === 'relay'), 'no notice');
}

test('#759: an old turn that has ended isn’t relayed', async (t) => {
  const h = await host(t);
  await h.first.hangUp();
  writeFileSync(hostPaths(h.home, VERSION).turn('ta', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
  h.alive.delete('ta');
  await untouched(h, await drive(h.b));
});

test('#759: an old turn whose runner.json this version’s check refuses is left to the old daemon, and never silent', async (t) => {
  const h = await host(t, {
    // A’s shim queues a call while A’s laptop is gone; then the turn’s runner record is damaged, its version kept.
    async beforeB({ first, shim, home }) {
      await first.hangUp();
      shim.shimSend('call', { id: 'c1', name: 'show_block', args: { block: BLOCK } });
      const file = hostPaths(home, VERSION).turn('ta', TURN_FILES.runner);
      const tools = hostPaths(home, VERSION).turn('ta', TURN_FILES.tools);
      await until(() => existsSync(tools) && readFileSync(tools, 'utf8').includes('c1'), 'the call written down');
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pid: 'x' }));
    },
  });
  const pb = await drive(h.b);
  // B relays it by the version its record names. Here B’s cleanup has already retired A’s folder, socket and all,
  // since it counts only records that pass its check (cleanup.mjs): so the turn hears off, rather than nothing.
  assert.deepEqual(await pb.msgs.next('relay'), { type: 'relay', turn: 'ta', version: OLD, state: 'off' });
  await sleep(30);
  assert.ok(!pb.msgs.messages.some((m) => m.type === 'tool'), 'B’s broker left A’s call to A');
});
