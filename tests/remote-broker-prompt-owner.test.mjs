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
    assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: ALLOW })).errors, []);
    assert.deepEqual(await s.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: ALLOW });
    await sleep(20);
    assert.deepEqual(answers(bystander), [], 'the bystander heard nothing');
  } finally {
    await h.done();
  }
});

test('#353 a connection that sends another shim’s prompt again, identical, gets none of its answer', async () => {
  const h = makeHome();
  try {
    const { k, s } = await asked(h);
    {
      const copy = connectShim(k.b, 't1', turnToken('t1'), OTHER);
      await copy.next('welcome');
      copy.send('permission', { id: 'p1', request: structuredClone(REQUEST) });
      const got = await copy.next('permission-answer');
      assert.equal(got.result.behavior, 'deny', 'another key: refused');
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

test('#353 a prompt written down with no key isn’t one a shim with a key may take after a restart', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    // As a daemon before #908 wrote a keyless shim’s prompt: owner null, which no connection has any more.
    const rec = { op: 'prompt', id: 'p1', entry: 'e1', owner: null, request: REQUEST, at: Date.now() };
    writeFileSync(h.p.turn('t1', TURN_FILES.prompts), `${JSON.stringify(rec)}\n`);
    const k = makeBroker(h);
    await k.b.load([{ turn: 't1', state: 'running' }]);
    for (const key of [OTHER, KEY]) {
      const copy = connectShim(k.b, 't1', turnToken('t1'), key);
      await copy.next('welcome');
      copy.send('permission', { id: 'p1', request: REQUEST });
      assert.match((await copy.next('permission-answer')).result.message, /asked by another connection/, `key ${key[0]}`);
    }
  } finally {
    await h.done();
  }
});

test('#908 a hello with no key is refused, and the connection hears nothing of the turn', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const keyless = connectShim(k.b, 't1', turnToken('t1'), null);
    const first = await keyless.next('error');
    assert.equal(keyless.got[0], first, 'its first message is the refusal, not a welcome');
    assert.equal(first.code, 'version');
    assert.match(first.message, /Install Postbox on this host again/);
    assert.ok(keyless.ended, 'and the connection is closed');
    keyless.send('call', { id: 'c1', name: 'corpus_search', args: { query: 'q' } });
    keyless.send('permission', { id: 'p1', request: REQUEST });
    await k.b.stopping('t1');
    await sleep(20);
    assert.deepEqual(keyless.got, [first], 'its call, its prompt and Stop reach it with nothing');
    assert.deepEqual(k.sent, [], 'and Postbox heard nothing of them');
  } finally {
    await h.done();
  }
});
