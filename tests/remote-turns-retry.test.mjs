// Retry after a turn on a host was continued and failed (#120, #151; tests/remote-turns-continued.test.mjs has the
// rest): it asks what the turn it continues was asked, a request too large to keep inline is read back from Postbox's
// store byte for byte, and one that can't be read back exactly, or whose agent went while it was read, isn't sent.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Blobs } from '../server/blobs.mjs';
import { keepOrigin, ORIGIN_MESSAGE_MAX, ORIGIN_REF_MAX, readRef } from '../server/remote/turns-origin.mjs';
import { askedAgain, askedOf } from '../server/turn-marks.mjs';
import { messageOf, rig, settled, sleep, starts, until } from './remote-turns-helpers.mjs';

/** Another agent, on this computer, in the conversation: what it’s sent is what its mock got. @param {any} r @param {any[]} [got] */
function lead(r, got = []) {
  r.rt.adapters.register({ name: 'mock', deliver: async (/** @type {any} */ _se, /** @type {any} */ m) => void got.push(m) });
  const p = r.rt.personaByHandle('lead') ?? r.rt.createPersona({ handle: 'lead', backend: 'mock' });
  return { se: r.rt.ensureSession(r.t.id, p.id), got };
}

const all = (/** @type {any} */ r) => Object.values(r.store.state.items).flat();
const threadOf = (/** @type {any} */ r, /** @type {any} */ it) => Object.keys(r.store.state.items).find((k) => r.store.state.items[k].includes(it));
const reads = (/** @type {any} */ d, /** @type {string} */ turn) => d.received.filter((/** @type {any} */ m) => m.type === 'read' && m.turn === turn);
const reply = (/** @type {any} */ r) => all(r).find((i) => i.kind === 'agent' && i.handle === 'coder' && i.status === 'done' && i.text);

/** Waits for the newest start’s turn to run on the host, and returns its ID. @param {any} r @param {number} n */
async function onHost(r, n) {
  await until(() => starts(r.d).length === n && r.d.turns.has(starts(r.d)[n - 1].turn), `start ${n} on the host`);
  const turn = starts(r.d)[n - 1].turn;
  await until(() => reads(r.d, turn).length > 0, 'its read');
  return turn;
}

test('#120, #151, #377: Retry after a resumed wake fails asks what the wake asked, where it was woken', async () => {
  const r = rig();
  const { se: a, got } = lead(r);
  assert.equal(r.rt.agentWake(a.id, 'coder', 'Is hello.txt there?').ok, true);
  const first = await onHost(r, 1);
  r.hosts.state = 'reconnecting'; // so it waits to resume
  r.d.interrupt(first);
  await until(() => r.se().remoteTurn.state === 'interrupted', 'Interrupted');
  // The resume can’t start: Postbox doesn’t know its own version.
  const build = r.rt.config.build;
  r.rt.config.build = {};
  r.hosts.state = null;
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await until(() => all(r).some((i) => i.status === 'failed' && /its own version/.test(i.error ?? '')), 'the resume to fail');
  const failed = all(r).find((i) => i.status === 'failed' && /its own version/.test(i.error ?? ''));
  assert.deepEqual(
    { kind: failed.asked.message.kind, from: failed.asked.message.from, text: failed.asked.message.text },
    { kind: 'agent', from: '@lead', text: 'Is hello.txt there?' },
  );
  // A small request is kept inline, in the record and on the failed reply.
  assert.equal(r.se().remoteTurn.origin.message.text, 'Is hello.txt there?');
  assert.equal('messageRef' in r.se().remoteTurn.origin, false);
  assert.equal('messageRef' in failed.asked, false);
  await settled(r);
  r.rt.config.build = build;
  r.rt.retry(threadOf(r, failed), failed.id);
  const again = await onHost(r, 2);
  assert.match(messageOf(starts(r.d)[1]), /@lead wrote to you\. Your reply posts here;.*\n\nIs hello\.txt there\?/s);
  r.d.end(again);
  await settled(r);
  assert.equal(threadOf(r, reply(r)), threadOf(r, failed), 'it answers where it was woken');
  assert.equal(got.length, 0, 'and wakes the agent that woke it only by an @-mention (#377)');
});

/**
 * A turn on the host Interrupted, whose resume then fails (Postbox doesn’t know its own version), so its failed reply
 * offers Retry: the item, and the thread it’s in, with the version put back so Retry can start.
 * @param {any} r
 */
async function failedResume(r) {
  const first = await onHost(r, 1);
  r.hosts.state = 'reconnecting'; // so it waits to resume
  r.d.interrupt(first);
  await until(() => r.se().remoteTurn.state === 'interrupted', 'Interrupted');
  const build = r.rt.config.build;
  r.rt.config.build = {};
  r.hosts.state = null;
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await until(() => all(r).some((i) => i.status === 'failed' && /its own version/.test(i.error ?? '')), 'the resume to fail');
  await settled(r);
  r.rt.config.build = build;
  const failed = all(r).find((i) => i.status === 'failed' && /its own version/.test(i.error ?? ''));
  return { failed, threadId: /** @type {string} */ (threadOf(r, failed)) };
}

/** 50,000 characters, as the most sendMessage takes, none of them an @-mention. */
const LONG = Array.from({ length: 3000 }, (_, i) => `Line ${i}: “quoted”, naïve café ✓ \\ "x"\n`)
  .join('')
  .slice(0, 50_000);

test('#120, #151: Retry after a resumed turn fails sends a request over 32,000 characters again byte for byte', async () => {
  const r = rig();
  const dir = mkdtempSync(join(tmpdir(), 'pb-origin-'));
  try {
    r.rt.blobs = new Blobs(dir);
    assert.equal(LONG.length, 50_000);
    r.rt.sendMessage(r.t.id, { text: LONG });
    const { failed, threadId } = await failedResume(r);
    // Kept in the store, by its hash, and named by the record and the failed reply; not inline.
    const { origin } = r.se().remoteTurn;
    assert.equal('message' in origin, false);
    assert.deepEqual(Object.keys(origin.messageRef), ['sha256', 'size']);
    assert.ok(origin.messageRef.size > ORIGIN_MESSAGE_MAX);
    assert.deepEqual(failed.asked, { messageRef: origin.messageRef, kind: 'user', summarizeTo: null });
    await r.rt.retry(threadId, failed.id);
    const again = await onHost(r, 2);
    assert.ok(messageOf(starts(r.d)[1]).includes(LONG), 'the whole request, as it was sent');
    r.d.end(again);
    await settled(r);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#120, #151: archiving the agent while Retry reads its kept request leaves the reply failed, and starts nothing', async () => {
  const r = rig();
  const dir = mkdtempSync(join(tmpdir(), 'pb-origin-'));
  try {
    r.rt.blobs = new Blobs(dir);
    r.rt.sendMessage(r.t.id, { text: LONG });
    const { failed, threadId } = await failedResume(r);
    // The read waits until the agent is archived, as it might on a slow --data folder.
    const get = r.rt.blobs.get.bind(r.rt.blobs);
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((ok) => (release = () => ok(undefined)));
    r.rt.blobs.get = async (/** @type {string} */ sha) => {
      await gate;
      return get(sha);
    };
    const retried = r.rt.retry(threadId, failed.id);
    r.rt.archive(r.se().id);
    const needs = r.se().needs;
    release();
    await assert.rejects(retried, { status: 409, message: /session is archived\. Restore it first\./ });
    await sleep(20);
    assert.equal(r.store.item(threadId, failed.id).status, 'failed', 'still failed, for Retry once it’s restored');
    assert.deepEqual(r.se().needs, needs, 'what it needs is as the archive left it');
    assert.equal(starts(r.d).length, 1, 'nothing started on the host');
    assert.equal(r.rt.turns.size, 0, 'no turn here either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#120, #151: Retry refuses, and sends nothing, when the request a resumed turn kept in the store is damaged or missing', async () => {
  const r = rig();
  const dir = mkdtempSync(join(tmpdir(), 'pb-origin-'));
  try {
    r.rt.blobs = new Blobs(dir);
    r.rt.sendMessage(r.t.id, { text: LONG });
    const { failed, threadId } = await failedResume(r);
    const path = r.rt.blobs.pathOf(failed.asked.messageRef.sha256);
    const refused = {
      status: 409,
      message: /^Postbox couldn’t recover the request this reply answered, so Retry can’t send it again exactly\. Send it again yourself/,
    };
    writeFileSync(path, JSON.stringify({ kind: 'user', text: 'Something else entirely.' }));
    await assert.rejects(r.rt.retry(threadId, failed.id), refused, 'damaged');
    rmSync(path);
    await assert.rejects(r.rt.retry(threadId, failed.id), refused, 'missing');
    r.rt.blobs = null;
    await assert.rejects(r.rt.retry(threadId, failed.id), refused, 'no store');
    await sleep(20);
    assert.equal(starts(r.d).length, 1, 'nothing started on the host');
    assert.equal(r.rt.turns.size, 0, 'no turn here either');
    assert.equal(r.store.item(threadId, failed.id).status, 'failed', 'still failed, for the person to send it again');
    assert.equal(r.se().needs.kind, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#120: a turn on a host keeps a small request inline, a large one in the store by its hash, and one it can’t keep as lost', async () => {
  const puts = [];
  const blobs = new Blobs('/nowhere');
  blobs.put = async (/** @type {Buffer} */ b) => {
    puts.push(b);
    return { sha256: 'a'.repeat(64), size: b.length, path: '' };
  };
  const turn = (/** @type {any} */ message) => ({ kind: message.kind, movesOn: true, from: null, asked: { message } });
  const small = { kind: 'user', text: 'hi', attachments: [] };
  const record = await keepOrigin({ blobs }, turn(small), null);
  assert.deepEqual(record, { kind: 'user', movesOn: true, from: null, summarizeTo: null, woke: null, message: small });
  assert.notEqual(record.message, small, 'a copy');
  assert.equal(puts.length, 0, 'nothing written for it');
  const large = { kind: 'user', text: 'é'.repeat(ORIGIN_MESSAGE_MAX), attachments: [] };
  assert.deepEqual((await keepOrigin({ blobs }, turn(large), null)).messageRef, { sha256: 'a'.repeat(64), size: Buffer.byteLength(JSON.stringify(large)) });
  assert.equal(puts[0].toString('utf8'), JSON.stringify(large), 'its JSON, as UTF-8');
  const lost = { message: null, lost: true };
  const failing = Object.assign(new Blobs('/nowhere'), { put: async () => Promise.reject(new Error('ENOSPC')) });
  for (const b of [null, failing]) assert.deepEqual((({ message, lost }) => ({ message, lost }))(await keepOrigin({ blobs: b }, turn(large), null)), lost);
  assert.deepEqual((await keepOrigin({ blobs }, turn({ kind: 'notice', text: '', attach: 'host-turn-1' }), null)).message, null, 'an attach asks nothing');
  // A ref read back from disk is a SHA-256 and a whole size within the bound.
  assert.deepEqual(readRef({ sha256: 'b'.repeat(64), size: 40_000 }), { sha256: 'b'.repeat(64), size: 40_000 });
  for (const v of [
    null,
    { sha256: 'B'.repeat(64), size: 1 },
    { sha256: '../x', size: 1 },
    { sha256: 'b'.repeat(64), size: 1.5 },
    { sha256: 'b'.repeat(64), size: ORIGIN_REF_MAX + 1 },
  ])
    assert.equal(readRef(v), null);
  // Retry refuses a lost one at once; one kept inline, or with nothing kept, sends as before.
  const asked = (/** @type {any} */ a) => askedOf({ kind: 'user', asked: { summarizeTo: null, ...a } });
  const here = { s: { sessions: { s1: { id: 's1', handle: 'coder', archived: false } } } };
  assert.deepEqual(asked({ message: null, lost: true }), { lost: true, summarizeTo: null });
  assert.throws(() => askedAgain(here, 't', { sessionId: 's1', asked: asked({ lost: true }) }, () => assert.fail('sent')), {
    status: 409,
    message: /couldn’t recover the request/,
  });
  assert.equal(asked({ message: null }), null);
  const sent = [];
  askedAgain(here, 't', { sessionId: 's1', asked: asked({ message: small }) }, (a) => void sent.push(a));
  assert.deepEqual(sent, [{ message: small, summarizeTo: null }]);
});
