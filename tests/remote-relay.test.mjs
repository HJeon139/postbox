// #759: a host’s turns left under an older Postbox, relayed by the newer daemon (designs/759-adopt-old-turns.md), on
// the fake host in tests/remote-relay-fixture.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RELAY_PREFIX } from '../server/remote/host/relay.mjs';
import { createLineReader, encode, hostPaths, MESSAGE_FILE, message, TURN_FILES } from '../shared/remote-protocol.mjs';
import { socketShim } from './remote-broker-daemon-setup.mjs';
import { BLOCK, REQUEST, sleep, TOKEN, until, VERSION } from './remote-broker-fixtures.mjs';
import { ALLOW, drive, host, OLD, welcomeOf } from './remote-relay-fixture.mjs';

test('#759: an old turn’s queued call and open prompt reach Postbox through the new daemon, and the answers reach its shim', async (t) => {
  const h = await host(t);
  await h.first.hangUp();
  // Made while no Postbox drives A: A holds them for the next one.
  h.shim.shimSend('call', { id: 'c1', name: 'show_block', args: { block: BLOCK } });
  h.shim.shimSend('permission', { id: 'p1', request: REQUEST });
  await sleep(20);
  const pb = await drive(h.b);
  const tool = await pb.msgs.next('tool');
  assert.deepEqual([tool.turn, tool.id, tool.name], ['ta', 'c1', 'show_block']);
  const prompt = await pb.msgs.next('prompt');
  assert.deepEqual([prompt.turn, prompt.id], ['ta', 'p1']);
  pb.send('answer', { turn: 'ta', prompt: 'p1', result: ALLOW });
  const answer = await until(() => h.shim.got.find((m) => m.type === 'permission-answer'), 'the answer at A’s shim');
  assert.equal(answer.id, 'p1');
  assert.deepEqual(answer.result, ALLOW);
  // A call made after the relay is up crosses too, and its reply reaches the shim.
  h.shim.shimSend('call', { id: 'c2', name: 'read_conversation', args: {} });
  const read = await until(() => pb.msgs.messages.find((m) => m.type === 'tool' && m.id === 'c2'), 'c2 at Postbox');
  assert.equal(read.turn, 'ta');
  pb.send('reply', { turn: 'ta', id: 'c2', ok: true, text: 'the conversation' });
  assert.equal((await until(() => h.shim.got.find((m) => m.id === 'c2'), 'c2’s result')).text, 'the conversation');
  assert.equal(pb.msgs.messages.filter((m) => m.type === 'relay').length, 0, 'no notice for a relayed turn');
  assert.ok(!h.logs.some((l) => l.includes(TOKEN)), 'the token is in no log');
});

test('#759: a relay never takes over: A still driven by its own Postbox refuses it as busy, and the turn gets the notice', async (t) => {
  const h = await host(t);
  const pb = await drive(h.b);
  const relay = await pb.msgs.next('relay');
  assert.deepEqual(relay, { type: 'relay', turn: 'ta', version: OLD, state: 'off' });
  // The laptop still on A keeps it, and still hears its turn.
  h.shim.shimSend('call', { id: 'c1', name: 'show_block', args: { block: BLOCK } });
  assert.equal((await h.first.msgs.next('tool')).id, 'c1');
  await sleep(20);
  assert.ok(!pb.msgs.messages.some((m) => m.type === 'tool'), 'nothing of A’s turn through B');
  assert.ok(
    h.logs.some((l) => l.includes('refused a relay: busy')),
    h.logs.join('\n'),
  );
});

test('#759: a daemon of another protocol gives the turn its notice, with nothing relayed', async (t) => {
  /** @type {string[]} */
  const heard = [];
  const h = await host(t, {
    // An older daemon whose protocol differs: it refuses every hello, as daemon-hello.mjs does.
    serveA(s) {
      const reader = createLineReader({ onLine: (l) => heard.push(l), onError: () => s.destroy() });
      s.on('data', (b) => {
        reader.push(b);
        s.end(`${JSON.stringify({ type: 'error', code: 'version', message: 'This host’s daemon speaks protocol 2.', re: 'hello' })}\n`);
      });
    },
  });
  await h.first.hangUp();
  const pb = await drive(h.b);
  assert.deepEqual(await pb.msgs.next('relay'), { type: 'relay', turn: 'ta', version: OLD, state: 'off' });
  const hello = JSON.parse(heard[0]);
  assert.equal(hello.type, 'hello');
  assert.equal(hello.token, TOKEN, 'the token goes in the hello');
  assert.ok(hello.instance.startsWith(RELAY_PREFIX));
  assert.ok(!Object.hasOwn(hello, 'takeover'), 'a relay never takes over');
  assert.ok(!h.logs.some((l) => l.includes(TOKEN)), 'the token is in no log');
});

test('#759: a relay that drops while the turn runs tells Postbox it was lost', async (t) => {
  const h = await host(t);
  await h.first.hangUp();
  h.shim.shimSend('permission', { id: 'p1', request: REQUEST });
  const pb = await drive(h.b);
  await pb.msgs.next('prompt');
  for (const s of h.sockets) s.destroy();
  assert.deepEqual(await pb.msgs.next('relay'), { type: 'relay', turn: 'ta', version: OLD, state: 'lost' });
});

test('#759: a Postbox restart while relaying sends the open prompt again as the same prompt, and its answer still reaches the shim', async (t) => {
  const h = await host(t);
  await h.first.hangUp();
  h.shim.shimSend('permission', { id: 'p1', request: REQUEST });
  const before = await drive(h.b);
  const entry = (await before.msgs.next('prompt')).entry;
  await before.hangUp();
  const after = await drive(h.b);
  const again = await after.msgs.next('prompt').catch((e) => {
    const relays = after.msgs.messages.filter((m) => m.type === 'relay');
    throw new Error(`${e.message} Relay: ${JSON.stringify(relays)}. Daemons: ${h.logs.join(' | ')}`);
  });
  assert.equal(again.entry, entry, 'the same prompt, which Postbox knows by its entry');
  await sleep(30);
  // A sends an open prompt again at each hello, and may send it before its welcome as well: Postbox knows each
  // resend by its entry (#353), so every one of them names the same.
  assert.deepEqual(new Set(after.msgs.messages.filter((m) => m.type === 'prompt').map((m) => m.entry)), new Set([entry]));
  assert.ok(!after.msgs.messages.some((m) => m.type === 'relay'), 'the old driver’s relay ended quietly');
  after.send('answer', { turn: 'ta', prompt: 'p1', result: ALLOW });
  await until(() => h.shim.got.find((m) => m.type === 'permission-answer'), 'the answer at A’s shim');
});

test('#759: a relay forwards only broker frames of its own turns', async (t) => {
  /** @type {import('node:net').Socket | null} */
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
  const frame = (/** @type {string} */ type, /** @type {any} */ body) => older?.write(encode(message('daemon-to-postbox', type, body)));
  frame('tool', { turn: 'other', id: 'x1', name: 'show_block', args: { block: BLOCK } });
  frame('line', { turn: 'ta', offset: 0, next: 3, text: '{}' });
  frame('started', { turn: 'ta' });
  frame('tool', { turn: 'ta', id: 'ok1', name: 'show_block', args: { block: BLOCK } });
  const tool = await pb.msgs.next('tool');
  assert.equal(tool.id, 'ok1');
  await sleep(20);
  assert.deepEqual(
    pb.msgs.messages.filter((m) => ['tool', 'line', 'started'].includes(m.type)).map((m) => m.id ?? m.type),
    ['ok1'],
  );
});

test('#759: a relay’s own hello opens no relay, so two versions can’t loop', async (t) => {
  const h = await host(t);
  await h.first.hangUp();
  const pb = await drive(h.b, `${RELAY_PREFIX}${'0'.repeat(40)}`);
  await sleep(40);
  assert.equal(h.sockets.size, 0, 'no connection to A');
  assert.ok(!pb.msgs.messages.some((m) => m.type === 'relay'), 'no notice: it opened none');
  assert.ok(!h.logs.some((l) => l.includes('relay')), h.logs.join('\n'));
});

test('#759: the new daemon’s own turns are as they were, and a turn under the same version isn’t relayed', async (t) => {
  const h = await host(t);
  await h.first.hangUp();
  const pb = await drive(h.b);
  pb.send('start', { turn: 'tb', harness: 'claude-code', folder: h.work, argv: [], env: {}, stdin: 'file', files: [{ name: MESSAGE_FILE, text: '{}\n' }] });
  await pb.msgs.next('started');
  const shim = socketShim(h.b);
  const p = hostPaths(h.home, VERSION);
  shim.shimSend('hello', { token: readFileSync(p.turn('tb', TURN_FILES.shimToken), 'utf8'), turn: 'tb', shim: 'j'.repeat(32) });
  await until(() => shim.got.find((m) => m.type === 'welcome'), 'tb’s shim welcome');
  shim.shimSend('call', { id: 'b1', name: 'read_conversation', args: {} });
  assert.equal((await pb.msgs.next('tool')).turn, 'tb');
  pb.send('reply', { turn: 'tb', id: 'b1', ok: true, text: 'B’s own' });
  assert.equal((await until(() => shim.got.find((m) => m.id === 'b1'), 'b1’s result')).text, 'B’s own');
  // Its next driver’s hello finds tb running under B’s own version: B relays only A’s turn.
  await pb.hangUp();
  const again = await drive(h.b);
  await until(() => h.sockets.size === 2, 'the relay to A opened again');
  await sleep(30);
  assert.deepEqual(
    again.msgs.messages.filter((m) => m.type === 'relay'),
    [],
  );
});
