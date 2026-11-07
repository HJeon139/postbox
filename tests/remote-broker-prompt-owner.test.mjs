// #353 on the host: a prompt’s answer goes only to the shim that asked it (server/remote/host/broker-prompts.mjs). Any
// client with a turn’s token can connect as one of its shims, so the daemon answers a prompt only on the connections of
// the shim whose key (its hello’s `shim`) sent it, never to every connection of the turn. The rig is
// tests/remote-broker-fixtures.mjs, beside tests/remote-broker-prompts.test.mjs, which is at its length limit.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, lines, makeBroker, makeHome, REQUEST, sleep, turnToken, until } from './remote-broker-fixtures.mjs';

const KEY = 'k'.repeat(32);
const OTHER = 'o'.repeat(32);
const ALLOW = { behavior: 'allow', updatedInput: REQUEST.input };
const answers = (s) => s.got.filter((m) => m.type === 'permission-answer');

/** A broker with shim `KEY` asking prompt p1 in turn t1, once it has reached Postbox. @param {any} h */
async function asked(h) {
  h.turn('t1');
  const k = makeBroker(h);
  const s = connectShim(k.b, 't1', turnToken('t1'), KEY);
  await s.next('welcome');
  s.send('permission', { id: 'p1', request: REQUEST });
  await until(() => k.sent.length, 'the prompt');
  return { k, s };
}

test('#353 a connection of the turn that only said hello gets no answer to another shim’s prompt', async () => {
  const h = makeHome();
  try {
    const { k, s } = await asked(h);
    const bystander = connectShim(k.b, 't1', turnToken('t1'), OTHER);
    await bystander.next('welcome');
    const keyless = connectShim(k.b, 't1');
    await keyless.next('welcome');
    assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: ALLOW })).errors, []);
    assert.deepEqual(await s.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: ALLOW });
    await sleep(20);
    assert.deepEqual(answers(bystander), [], 'the bystander heard nothing');
    assert.deepEqual(answers(keyless), [], 'nor did one with no key');
  } finally {
    await h.done();
  }
});

test('#353 a connection that sends another shim’s prompt again, identical, gets none of its answer', async () => {
  const h = makeHome();
  try {
    const { k, s } = await asked(h);
    for (const key of [OTHER, undefined]) {
      const copy = connectShim(k.b, 't1', turnToken('t1'), key);
      await copy.next('welcome');
      copy.send('permission', { id: 'p1', request: structuredClone(REQUEST) });
      const got = await copy.next('permission-answer');
      assert.equal(got.result.behavior, 'deny', `${key ? 'another key' : 'no key'}: refused`);
      assert.match(got.result.message, /asked by another connection/);
      assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: ALLOW })).errors, []);
      // Sent again once the person answered: still refused, never the allow.
      copy.send('permission', { id: 'p1', request: structuredClone(REQUEST) });
      await copy.next('permission-answer', (m) => m.result.behavior === 'deny');
      await sleep(20);
      assert.ok(
        answers(copy).every((m) => m.result.behavior === 'deny'),
        'the copy never gets the allow',
      );
    }
    assert.equal(k.sent.length, 1, 'nothing new reaches Postbox');
    assert.ok(
      answers(s).some((m) => m.result.behavior === 'allow'),
      'the shim that asked got it',
    );
  } finally {
    await h.done();
  }
});

test('#353 after the shim reconnects, its prompt’s answer reaches its new connection, and after a daemon restart too', async () => {
  const h = makeHome();
  try {
    const { k, s } = await asked(h);
    // The link drops; the same shim, with its key, connects again and sends its waiting prompt again.
    s.close();
    const back = connectShim(k.b, 't1', turnToken('t1'), KEY);
    await back.next('welcome');
    back.send('permission', { id: 'p1', request: REQUEST });
    await sleep(20);
    assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: ALLOW })).errors, []);
    assert.deepEqual(await back.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: ALLOW });
    // The record names the shim by its key’s hash, never the key.
    const [record] = lines(h.p.turn('t1', TURN_FILES.prompts));
    assert.match(record.owner, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(lines(h.p.turn('t1', TURN_FILES.prompts))).includes(KEY), 'the key isn’t written down');
    // A restarted daemon reads the owner back: another key is refused, the shim’s own gets the answer.
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    const copy = connectShim(again.b, 't1', turnToken('t1'), OTHER);
    await copy.next('welcome');
    copy.send('permission', { id: 'p1', request: REQUEST });
    assert.match((await copy.next('permission-answer')).result.message, /asked by another connection/);
    const after = connectShim(again.b, 't1', turnToken('t1'), KEY);
    await after.next('welcome');
    after.send('permission', { id: 'p1', request: REQUEST });
    assert.deepEqual(await after.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: ALLOW });
  } finally {
    await h.done();
  }
});

test('#353 a prompt an older daemon wrote down, with no owner, is taken by the first shim to send it again', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const first = connectShim(k.b, 't1');
    await first.next('welcome');
    first.send('permission', { id: 'p1', request: REQUEST });
    await until(() => k.sent.length, 'the prompt');
    // As an older daemon wrote it: no owner.
    const path = h.p.turn('t1', TURN_FILES.prompts);
    const old = lines(path).map((r) => {
      delete r.owner;
      return JSON.stringify(r);
    });
    writeFileSync(path, `${old.join('\n')}\n`);
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    const s = connectShim(again.b, 't1', turnToken('t1'), KEY);
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    await sleep(20);
    const copy = connectShim(again.b, 't1', turnToken('t1'), OTHER);
    await copy.next('welcome');
    copy.send('permission', { id: 'p1', request: REQUEST });
    assert.match((await copy.next('permission-answer')).result.message, /asked by another connection/);
    await again.hello();
    assert.deepEqual((await again.post('answer', { turn: 't1', prompt: 'p1', result: ALLOW })).errors, []);
    assert.deepEqual(await s.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: ALLOW });
    assert.ok(answers(copy).every((m) => m.result.behavior === 'deny'));
  } finally {
    await h.done();
  }
});

test('#353 a prompt from a shim that sent no key isn’t one a shim with a key may take, before a restart or after', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const keyless = connectShim(k.b, 't1');
    await keyless.next('welcome');
    keyless.send('permission', { id: 'p1', request: REQUEST });
    await until(() => k.sent.length, 'the prompt');
    assert.equal(lines(h.p.turn('t1', TURN_FILES.prompts))[0].owner, null, 'written down as no key, not as no owner');
    for (const b of [k.b, null]) {
      let broker = b;
      if (!broker) {
        const again = makeBroker(h);
        await again.b.load([{ turn: 't1', state: 'running' }]);
        broker = again.b;
      }
      const copy = connectShim(broker, 't1', turnToken('t1'), OTHER);
      await copy.next('welcome');
      copy.send('permission', { id: 'p1', request: REQUEST });
      assert.match((await copy.next('permission-answer')).result.message, /asked by another connection/, b ? 'before a restart' : 'after');
    }
  } finally {
    await h.done();
  }
});
