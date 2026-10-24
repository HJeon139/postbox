// The daemon’s broker (server/remote/host/broker.mjs, #120), driven in-process: what happens when a call, prompt,
// answer or reply can’t be written down. A shim is a pair of functions, Postbox is a list of what the broker sent it,
// and the turn folders are in a temp home (tests/remote-broker-fixtures.mjs). Nothing is spawned; the real daemon,
// runner and shim are in tests/integration/remote-broker.test.mjs.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { encode, message, TURN_FILES } from '../shared/remote-protocol.mjs';
import { BLOCK, blockFile, connectShim, lines, makeBroker, makeHome, REQUEST, sleep, TOKEN, until } from './remote-broker-fixtures.mjs';

test('a call or prompt the broker can’t write down isn’t acknowledged: the shim hears why, and nothing crosses to Postbox', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    // tools.jsonl and prompts.jsonl can’t be appended to: each is a folder.
    mkdirSync(h.p.turn('t1', TURN_FILES.tools));
    mkdirSync(h.p.turn('t1', TURN_FILES.prompts));
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const queued = await s.call('c1', 'show_block', { block: BLOCK });
    assert.equal(queued.ok, false, 'a queued call that isn’t on disk isn’t acknowledged');
    assert.match(queued.text, /^Postbox’s daemon on this host couldn’t write down show_block, so it wasn’t sent to Postbox: /);
    const asked = await s.call('c2', 'corpus_search', { query: 'y' });
    assert.equal(asked.ok, false);
    assert.match(asked.text, /^Postbox’s daemon on this host couldn’t write down corpus_search, so it wasn’t sent to Postbox: /);
    s.send('permission', { id: 'p1', request: REQUEST });
    const denied = await s.next('permission-answer');
    assert.equal(denied.result.behavior, 'deny', 'a prompt that isn’t on disk is denied, never left waiting or allowed');
    assert.match(denied.result.message, /^Postbox’s daemon on this host couldn’t write down this permission request, so it wasn’t shown: /);
    assert.deepEqual(k.sent, [], 'nothing reached Postbox');
    assert.deepEqual(await k.hello(), [], 'and nothing waits for its next hello');
    assert.deepEqual(k.b.pending.tools, []);
    assert.deepEqual(k.b.pending.prompts, []);
    const logged = k.logs.join('\n');
    assert.match(logged, /Couldn’t record call in .*tools\.jsonl/);
    assert.match(logged, /Couldn’t record prompt in .*prompts\.jsonl/);
    // Once the file can be written, the same call goes: the failure left nothing behind that stops it.
    rmSync(h.p.turn('t1', TURN_FILES.tools), { recursive: true });
    assert.equal((await s.call('c1', 'show_block', { block: BLOCK })).ok, true);
    assert.deepEqual(
      k.sent.map((m) => [m.type, m.id]),
      [['tool', 'c1']],
    );
  } finally {
    h.done();
  }
});

test('an answer the broker can’t write down doesn’t reach the shim: Postbox hears an error, the prompt waits, and a later answer goes', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const file = h.p.turn('t1', TURN_FILES.prompts);
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    await until(() => k.sent.length, 'the prompt');
    // prompts.jsonl can’t be appended to from here on: it’s a folder.
    blockFile(file);
    const allow = { behavior: 'allow', updatedInput: { command: 'ls' } };
    const failed = await k.post('answer', { turn: 't1', prompt: 'p1', result: allow });
    assert.equal(failed.errors.length, 1, 'Postbox hears the answer wasn’t taken');
    assert.equal(failed.errors[0].code, 'internal');
    assert.match(failed.errors[0].text, /^Postbox’s daemon on this host couldn’t write down the answer to prompt p1 in turn t1, so the agent didn’t get it: /);
    await sleep(20);
    assert.deepEqual(
      s.got.filter((m) => m.type === 'permission-answer'),
      [],
      'the shim hears nothing',
    );
    assert.deepEqual(
      k.b.pending.prompts.map((q) => [q.id, q.answer]),
      [['p1', null]],
      'the prompt still waits',
    );
    assert.deepEqual(
      (await k.hello()).map((m) => [m.type, m.id]),
      [['prompt', 'p1']],
      'and is sent again at the next hello',
    );
    // A shim that sends the prompt again hears nothing either: there’s no answer yet.
    s.send('permission', { id: 'p1', request: REQUEST });
    await sleep(20);
    assert.equal(s.got.filter((m) => m.type === 'permission-answer').length, 0);
    // Once the file can be written, the next answer goes.
    rmSync(file, { recursive: true });
    assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: allow })).errors, []);
    assert.deepEqual(await s.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: allow });
    assert.deepEqual(
      lines(file).map((x) => x.op),
      ['answer'],
    );
  } finally {
    h.done();
  }
});

test('an answer is on disk before the shim hears it, and an expiry before Postbox hears it', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const file = h.p.turn('t1', TURN_FILES.prompts);
    /** @type {any[]} what Postbox got, with what prompts.jsonl held as it did */
    const sent = [];
    const k = makeBroker(h, {
      toPostbox: (type, body) => {
        sent.push({ type, ...body, onDisk: lines(file).map((x) => x.op) });
        return true;
      },
    });
    /** @type {string[][]} what prompts.jsonl held as the shim heard each answer */
    const heard = [];
    const c = k.b.shim({
      first: JSON.stringify({ type: 'hello', token: TOKEN, turn: 't1' }),
      write: (line) => {
        if (line.includes('"permission-answer"')) heard.push(lines(file).map((x) => x.op));
        return true;
      },
      end: () => {},
    });
    const send = (type, body) => c.line(encode(message('shim-to-daemon', type, body)).trimEnd());
    send('permission', { id: 'p1', request: REQUEST });
    send('permission', { id: 'p2', request: REQUEST });
    await until(() => sent.length === 2, 'the prompts');
    await k.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'no' } });
    await until(() => heard.length, 'the answer');
    assert.deepEqual(heard, [['prompt', 'prompt', 'answer']], 'written down before the shim heard');
    send('permission-expired', { id: 'p2', at: 5 });
    await until(() => sent.length === 3, 'the expiry');
    assert.equal(sent[2].type, 'prompt-expired');
    assert.deepEqual(sent[2].onDisk, ['prompt', 'prompt', 'answer', 'expired'], 'written down before Postbox heard');
  } finally {
    h.done();
  }
});

/** Postbox’s reply to each call, while tools.jsonl can’t be appended to: each fails, and Postbox hears why. */
async function repliesNotTaken(k, ids) {
  for (const id of ids) {
    const failed = await k.post('reply', { turn: 't1', id, ok: true, text: `answer ${id}` });
    assert.equal(failed.errors.length, 1, `Postbox hears ${id}’s reply wasn’t taken`);
    assert.equal(failed.errors[0].code, 'internal');
    assert.match(
      failed.errors[0].text,
      new RegExp(`^Postbox’s daemon on this host couldn’t write down the reply to call ${id} in turn t1, so it wasn’t taken: `),
    );
  }
}

test('a reply the broker can’t write down doesn’t reach the shim: Postbox hears an error, the call waits, and a later reply goes', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const file = h.p.turn('t1', TURN_FILES.tools);
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('call', { id: 'c1', name: 'corpus_search', args: { query: 'y' } });
    assert.equal((await s.call('c2', 'show_block', { block: BLOCK })).ok, true);
    await until(() => k.sent.length === 2, 'the tools');
    // tools.jsonl can’t be appended to from here on: it’s a folder.
    blockFile(file);
    await repliesNotTaken(k, ['c1', 'c2']);
    await sleep(20);
    assert.deepEqual(
      s.got.filter((m) => m.type === 'result' && m.id === 'c1'),
      [],
      'the shim hears nothing',
    );
    assert.deepEqual(
      k.b.pending.tools.map((t) => t.id),
      ['c1', 'c2'],
      'both calls still wait',
    );
    assert.deepEqual(
      (await k.hello()).map((m) => [m.type, m.id, m.args]),
      [
        ['tool', 'c1', { query: 'y' }],
        ['tool', 'c2', { block: BLOCK }],
      ],
      'and are sent again, whole, at the next hello',
    );
    // Once the file can be written, the next replies go, written down before the shim hears.
    rmSync(file, { recursive: true });
    assert.deepEqual((await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: 'answer c1' })).errors, []);
    assert.deepEqual(await s.next('result', (m) => m.id === 'c1'), { type: 'result', id: 'c1', ok: true, text: 'answer c1' });
    assert.deepEqual((await k.post('reply', { turn: 't1', id: 'c2', ok: true, text: 'Shown.' })).errors, []);
    assert.deepEqual(
      lines(file).map((x) => [x.op, x.id]),
      [
        ['reply', 'c1'],
        ['reply', 'c2'],
      ],
    );
    assert.deepEqual(k.b.pending.tools, []);
    assert.equal((await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: 'again' })).errors[0].code, 'no-tool', 'a reply goes once');
  } finally {
    h.done();
  }
});
