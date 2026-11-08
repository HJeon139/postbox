// #908 on the host: only the shim that asked a prompt can end it (server/remote/host/broker-prompts.mjs’s endFromShim).
// Any client with a turn’s token can connect as one of its shims and name a prompt’s id, so a `permission-expired` or
// `permission-canceled` from another key is refused, exactly as one for an id nobody asked: nothing is written down,
// Postbox hears nothing, and the card stays. The rig is tests/remote-broker-fixtures.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, lines, makeBroker, makeHome, REQUEST, sleep, turnToken, until } from './remote-broker-fixtures.mjs';

const OTHER = 'o'.repeat(32);
const ALLOW = { behavior: 'allow', updatedInput: REQUEST.input };
const NOTICES = ['permission-expired', 'permission-canceled'];
const expiries = (k) => k.sent.filter((m) => m.type === 'prompt-expired');
const ends = (h) => lines(h.p.turn('t1', TURN_FILES.prompts)).filter((r) => r.op === 'expired');
const errors = (s) => s.got.filter((m) => m.type === 'error');

/** A broker with turn t1, its shim (the fixture’s key) and a bystander (another key), each welcomed. @param {any} h */
async function room(h) {
  h.turn('t1');
  const k = makeBroker(h);
  const s = connectShim(k.b, 't1');
  const bystander = connectShim(k.b, 't1', turnToken('t1'), OTHER);
  await s.next('welcome');
  await bystander.next('welcome');
  return { k, s, bystander };
}

/** The shim asks p1, and Postbox has it. */
async function ask(k, s, id = 'p1') {
  s.send('permission', { id, request: REQUEST });
  await until(() => k.sent.some((m) => m.type === 'prompt' && m.id === id), `prompt ${id} sent to Postbox`);
}

test('#908 a connection with another key can’t end a shim’s prompt: the card stays and the answer still reaches it', async () => {
  for (const type of NOTICES) {
    const h = makeHome();
    try {
      const { k, s, bystander } = await room(h);
      await ask(k, s);
      bystander.send(type, { id: 'p1', at: 1 });
      assert.equal((await bystander.next('error')).code, 'no-prompt', `${type}: refused`);
      assert.deepEqual(expiries(k), [], `${type}: Postbox heard nothing`);
      assert.deepEqual(ends(h), [], `${type}: nothing was written down`);
      assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: ALLOW })).errors, [], `${type}: the card can still be answered`);
      assert.deepEqual(await s.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: ALLOW });
    } finally {
      await h.done();
    }
  }
});

test('#908 an end for a prompt nobody asked writes nothing and tells Postbox nothing, and reads exactly as another shim’s', async () => {
  const h = makeHome();
  try {
    const { k, s, bystander } = await room(h);
    bystander.send('permission-canceled', { id: 'p1', at: 1 });
    await bystander.next('error');
    const unknown = bystander.raw.at(-1);
    assert.deepEqual(k.sent, [], 'Postbox heard nothing');
    assert.deepEqual(lines(h.p.turn('t1', TURN_FILES.prompts)), [], 'nothing was written down');
    // The same id, now another shim’s prompt: the refusal says nothing that tells the two apart.
    await ask(k, s);
    bystander.send('permission-canceled', { id: 'p1', at: 1 });
    await bystander.next('error');
    assert.equal(bystander.raw.at(-1), unknown, 'byte for byte the reply an unknown id gets');
    assert.deepEqual(expiries(k), []);
  } finally {
    await h.done();
  }
});

test('#908 the shim that asked can still end its prompt, before a restart and after', async () => {
  const h = makeHome();
  try {
    const { k, s } = await room(h);
    await ask(k, s);
    s.send('permission-canceled', { id: 'p1', at: 5 });
    await until(() => expiries(k).length, 'the expiry');
    assert.deepEqual(expiries(k), [{ type: 'prompt-expired', id: 'p1', turn: 't1', at: 5, reason: 'canceled' }]);
    await ask(k, s, 'p2');
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    const back = connectShim(again.b, 't1');
    await back.next('welcome');
    back.send('permission-expired', { id: 'p2', at: 6 });
    await until(() => expiries(again).length, 'the expiry after the restart');
    assert.deepEqual(expiries(again), [{ type: 'prompt-expired', id: 'p2', turn: 't1', at: 6, reason: 'expired' }]);
    assert.deepEqual(errors(back), [], 'accepted');
  } finally {
    await h.done();
  }
});

test('#908 a notice for a prompt that already ended adds nothing, from its shim or another', async () => {
  const h = makeHome();
  try {
    const { k, s, bystander } = await room(h);
    await ask(k, s);
    s.send('permission-expired', { id: 'p1', at: 1 });
    await until(() => expiries(k).length, 'the expiry');
    for (const c of [s, bystander]) {
      c.send('permission-canceled', { id: 'p1', at: 2 });
      assert.equal((await c.next('error')).code, 'no-prompt');
    }
    assert.equal(expiries(k).length, 1, 'Postbox heard one expiry');
    assert.equal(ends(h).length, 1, 'and one was written down');
  } finally {
    await h.done();
  }
});

test('#908 after Stop, a shim’s notice adds no second expiry', async () => {
  const h = makeHome();
  try {
    const { k, s, bystander } = await room(h);
    await ask(k, s);
    await k.b.stopping('t1');
    assert.equal(expiries(k).length, 1, 'Stop ended the prompt');
    for (const c of [s, bystander]) {
      c.send('permission-canceled', { id: 'p1', at: 2 });
      await c.next('error', (m) => m.code === 'no-prompt');
    }
    assert.equal(expiries(k).length, 1, 'still one expiry');
    assert.equal(ends(h).length, 1);
  } finally {
    await h.done();
  }
});

/** Shim `s` asked p1 and the person allowed it. */
async function allowed(k, s) {
  await ask(k, s);
  assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: ALLOW })).errors, []);
  await s.next('permission-answer');
}

test('#908 a bystander can’t undo an answer: the shim that asked gets it on its resend', async () => {
  const h = makeHome();
  try {
    const { k, s, bystander } = await room(h);
    await allowed(k, s);
    bystander.send('permission-canceled', { id: 'p1', at: 1 });
    assert.equal((await bystander.next('error')).code, 'no-prompt');
    s.close();
    const back = connectShim(k.b, 't1');
    await back.next('welcome');
    back.send('permission', { id: 'p1', request: REQUEST });
    assert.deepEqual(await back.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: ALLOW });
    assert.equal(k.sent.filter((m) => m.type === 'prompt').length, 1, 'no second prompt');
    assert.deepEqual(expiries(k), []);
  } finally {
    await h.done();
  }
});

test('#908 the shim that asked ending an answered prompt changes nothing: the allow stays', async () => {
  const h = makeHome();
  try {
    const { k, s } = await room(h);
    await allowed(k, s);
    const written = lines(h.p.turn('t1', TURN_FILES.prompts)).length;
    for (const type of NOTICES) s.send(type, { id: 'p1', at: 1 });
    await sleep(30);
    assert.deepEqual(errors(s), [], 'accepted, with nothing to say');
    assert.equal(lines(h.p.turn('t1', TURN_FILES.prompts)).length, written, 'nothing written down');
    assert.deepEqual(expiries(k), [], 'Postbox heard nothing, so the card keeps its allow');
    s.send('permission', { id: 'p1', request: REQUEST });
    assert.deepEqual((await s.next('permission-answer')).result, ALLOW, 'a resend still gets the allow');
  } finally {
    await h.done();
  }
});
