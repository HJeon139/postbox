// Asking a host for its models (server/remote/hosts-models.mjs, #1304): `models` out, `listed` back, with the host
// kept connected while it waits, and why it gave none when it didn’t.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hostModels, LISTED_WAIT_MS } from '../server/remote/hosts-models.mjs';

/**
 * A host manager (hosts.mjs) with one link. answer(msg) is what the daemon sends back for each message Postbox
 * sends; channel is the link, with what was sent, and needs the need and release calls.
 */
function fakeHosts({ answer = () => null, welcome = async () => ({}), send = true } = {}) {
  const channel = Object.assign(new EventEmitter(), { connected: true, sent: [] });
  channel.send = (msg) => {
    channel.sent.push(msg);
    const reply = answer(msg);
    if (reply) setImmediate(() => channel.emit('message', reply));
    return send;
  };
  const needs = [];
  return {
    channel,
    needs,
    ensureWelcome: welcome,
    link: () => channel,
    need: (id, why) => needs.push(['need', id, typeof why]),
    release: (id, why) => needs.push(['release', id, typeof why]),
  };
}

test('the host’s list comes back for the harness asked, with the host kept connected only while it waits', async () => {
  const h = fakeHosts({ answer: (m) => (m.type === 'models' ? { type: 'listed', harness: m.harness, models: ['gpt-6.1-sol', 'gpt-5.6-terra'] } : null) });
  assert.deepEqual(await hostModels(h, 'ho_1', 'codex'), ['gpt-6.1-sol', 'gpt-5.6-terra']);
  assert.deepEqual(h.channel.sent, [{ type: 'models', harness: 'codex' }]);
  assert.deepEqual(h.needs, [
    ['need', 'ho_1', 'symbol'],
    ['release', 'ho_1', 'symbol'],
  ]);
});

test('another harness’s answer isn’t taken for this one', async () => {
  const h = fakeHosts();
  const asking = hostModels(h, 'ho_1', 'claude-code');
  await new Promise((r) => setImmediate(r));
  h.channel.emit('message', { type: 'listed', harness: 'codex', models: ['gpt-6'] });
  h.channel.emit('message', { type: 'listed', harness: 'claude-code', models: ['claude-opus-5-5'] });
  assert.deepEqual(await asking, ['claude-opus-5-5']);
});

test('a host that can’t be reached is unreachable, and the need is released', async () => {
  const h = fakeHosts({ welcome: async () => Promise.reject(Object.assign(new Error('ssh: connect to host timed out'), { code: 'failed' })) });
  await assert.rejects(hostModels(h, 'ho_1', 'codex'), (e) => e.code === 'unreachable' && /timed out/.test(e.message));
  assert.deepEqual(h.channel.sent, [], 'nothing is sent to a host that isn’t there');
  assert.equal(h.needs.at(-1)[0], 'release');
});

test('a host Postbox doesn’t have keeps the manager’s no-host', async () => {
  const h = fakeHosts({ welcome: async () => Promise.reject(Object.assign(new Error('No such host.'), { code: 'no-host' })) });
  await assert.rejects(hostModels(h, 'ho_x', 'codex'), (e) => e.code === 'no-host');
});

// What a daemon from before `models` answers it, recorded from main’s daemon at 5b0ef806: it refuses the line as a
// message it doesn’t know, naming no request.
const BEFORE_MODELS = JSON.parse(readFileSync(new URL('./fixtures/remote/models-before-1312.json', import.meta.url), 'utf8'));

test('a daemon from before `models` is outdated, at once, not after the wait', async () => {
  const h = fakeHosts({ answer: () => BEFORE_MODELS });
  const timers = [];
  const asking = hostModels(h, 'ho_1', 'kiro-cli', { setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {} });
  await assert.rejects(asking, (e) => e.code === 'outdated');
  assert.equal(timers.length, 1, 'its timer was set, and never needed');
});

test('a daemon that has `models` but refuses it now, such as one being removed, is not-listed', async () => {
  const h = fakeHosts({ answer: () => ({ type: 'error', code: 'internal', re: 'models', message: 'Postbox is being removed from this host.' }) });
  await assert.rejects(hostModels(h, 'ho_1', 'kiro-cli'), (e) => e.code === 'not-listed');
});

test('a host whose CLI listed none is not-listed', async () => {
  const h = fakeHosts({ answer: (m) => ({ type: 'listed', harness: m.harness, models: [] }) });
  await assert.rejects(hostModels(h, 'ho_1', 'kiro-cli'), (e) => e.code === 'not-listed');
});

test('a connection that closes while it waits, or a send that fails, is unreachable', async () => {
  const h = fakeHosts();
  const asking = hostModels(h, 'ho_1', 'codex');
  await new Promise((r) => setImmediate(r));
  h.channel.connected = false;
  h.channel.emit('state');
  await assert.rejects(asking, (e) => e.code === 'unreachable');
  await assert.rejects(hostModels(fakeHosts({ send: false }), 'ho_1', 'codex'), (e) => e.code === 'unreachable');
});

test('a host that never answers is unreachable after LISTED_WAIT_MS', async () => {
  const h = fakeHosts();
  const timers = [];
  const asking = hostModels(h, 'ho_1', 'codex', { setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(timers[0].ms, LISTED_WAIT_MS);
  timers[0].fn();
  await assert.rejects(asking, (e) => e.code === 'unreachable' && /in time/.test(e.message));
});
