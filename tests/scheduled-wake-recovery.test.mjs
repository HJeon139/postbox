// #466: a scheduled wake survives a network failure, without replaying a turn that already started a tool call.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';
import { kiroError } from '../server/adapters/kiro-errors.mjs';
import { failure, SshFailure } from '../server/remote/ssh-failures.mjs';
import { fireScheduledWake, isNetworkFailure } from '../server/scheduled-wakes.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const networkError = (code = 'ENOTFOUND') => Object.assign(new Error(`network failed: ${code}`), { code });
const fire = async (f, sc) => {
  clearTimeout(f.rt.timers.get(sc.id));
  fireScheduledWake(f.rt, sc);
  await settle(f.rt);
};

test('#466 network failures are structured SSH failures or portable network error codes', () => {
  assert.equal(isNetworkFailure(new SshFailure('unreachable', 'Offline.', 'Reconnect.')), true);
  for (const code of ['EADDRNOTAVAIL', 'ENOTFOUND', 'ECONNRESET']) assert.equal(isNetworkFailure(networkError(code)), true, code);
  assert.equal(isNetworkFailure(Object.assign(new Error('Quota exhausted.'), { code: 'rate_limit' })), false);
});

test('#466 a real Kiro runError keeps its portable network code as the adapter error’s cause', () => {
  const mapper = createKiroMapper({ status() {}, activity() {}, reported() {}, denied() {} });
  mapper.push({
    type: 'runError',
    data: { sessionId: 'session-1', stage: 'run', message: 'Internal error (code -32603): {"details":"read EADDRNOTAVAIL"}' },
  });
  assert.equal(isNetworkFailure(kiroError(mapper.error, mapper.error)), true);
});

test('#466 a scheduled wake retries with the same id after a network error before any tool starts', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check the run.' });
  f.adapter.next.push(async () => {
    throw failure('unreachable', 'the test host', { code: 255, stderr: 'ssh: connect to host test port 22: Network is unreachable' });
  });
  await fire(f, sc);

  const retry = f.store.state.schedules[sc.id];
  assert.ok(retry, 'the wake is pending again under the same id');
  assert.equal(retry.id, sc.id);
  assert.ok(retry.at > Date.now() && retry.at - Date.now() <= 60_000, 'the retry uses bounded backoff');
  assert.ok(f.rt.timers.has(sc.id), 'its bounded retry is armed');
  assert.equal(f.store.item(sc.threadId, sc.itemId).status, 'pending');

  clearTimeout(f.rt.timers.get(sc.id));
  f.adapter.next.push(async (ctx) => ctx.text('The run is done.'));
  await fire(f, retry);
  assert.equal(f.store.state.schedules[sc.id], undefined, 'success settles the schedule');
  assert.equal(
    f.store.items(sc.threadId).filter((item) => item.kind === 'system' && item.variant === 'wake').length,
    1,
    'retries update the schedule line instead of adding wake lines',
  );
  assert.deepEqual(
    f.adapter.calls.map((call) => [call.message.note, call.message.scheduledWakeId]),
    [
      ['Check the run.', sc.id],
      ['Check the run.', sc.id],
    ],
  );
});

test('#466 Cancel is never undone by Retry from a stale failed reply', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check once.' });
  f.adapter.next.push(async () => {
    throw networkError();
  });
  await fire(f, sc);
  const failed = f.store.items(sc.threadId).findLast((item) => item.kind === 'agent' && item.status === 'failed');
  f.rt.cancelSchedule(sc.id);
  f.adapter.next.push(async () => {
    throw networkError('ECONNRESET');
  });
  f.rt.retry(sc.threadId, failed.id);
  await settle(f.rt);
  assert.equal(f.store.state.schedules[sc.id], undefined);
  assert.equal(f.rt.timers.has(sc.id), false);
});

test('#466 manual Retry cancels an armed automatic retry, so the instruction runs once', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check once.' });
  f.adapter.next.push(async () => {
    throw networkError();
  });
  await fire(f, sc);
  const failed = f.store.items(sc.threadId).findLast((item) => item.kind === 'agent' && item.status === 'failed');
  f.adapter.next.push(async (ctx) => ctx.text('Done after the manual retry.'));
  f.rt.retry(sc.threadId, failed.id);
  await settle(f.rt);
  fireScheduledWake(f.rt, sc.id);
  await settle(f.rt);
  assert.equal(f.adapter.calls.length, 2);
  assert.equal(f.store.state.schedules[sc.id], undefined);
});

test('#466 manual Retry cannot replace a tool-aware recovery with the original instruction', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Deploy and report.' });
  f.adapter.next.push(async (ctx) => {
    ctx.activity({ id: 'kiro-tool', label: 'Deploy to test', state: 'running', kind: 'tool' });
    throw networkError();
  });
  await fire(f, sc);
  const failed = f.store.items(sc.threadId).findLast((item) => item.kind === 'agent' && item.status === 'failed');
  f.adapter.next.push(async () => {
    throw networkError('ECONNRESET');
  });
  f.rt.retry(sc.threadId, failed.id);
  await settle(f.rt);
  const current = f.store.state.schedules[sc.id];
  assert.deepEqual(current.recoveryTools, ['Deploy to test']);
  assert.match(current.recoveryNote, /Deploy to test/);
  assert.notEqual(current.recoveryNote, sc.note);
  f.rt.cancelSchedule(sc.id);
});

test('#466 a quota failure stays failed and does not retry', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check quota.' });
  f.adapter.next.push(async () => {
    throw Object.assign(new Error('Quota exhausted.'), { code: 'rate_limit' });
  });
  await fire(f, sc);

  assert.equal(f.store.state.schedules[sc.id], undefined);
  assert.equal(f.rt.timers.has(sc.id), false);
  assert.equal(f.adapter.calls.length, 1);
  assert.equal(f.store.items(sc.threadId).findLast((item) => item.kind === 'agent')?.status, 'failed');
});

test('#466 a host turn marked lost is attached again, not also retried as a scheduled wake', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check the host.' });
  f.adapter.next.push(async () => {
    f.rt.updateSession(f.alpha.id, { remoteTurn: { state: 'lost' } });
    throw failure('unreachable', 'the test host', { code: 255, stderr: 'ssh: connect to host test port 22: Network is unreachable' });
  });
  await fire(f, sc);

  assert.equal(f.store.state.schedules[sc.id], undefined, 'RemoteTurns owns reconnection, so no second recovery is armed');
  assert.equal(f.rt.timers.has(sc.id), false);
  assert.equal(f.adapter.calls.length, 1);
});

test('#466 exponential backoff reaches its documented five-minute cap', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check later.' });
  sc.attempt = 9;
  f.store.emit('schedule', sc);
  f.adapter.next.push(async () => {
    throw networkError();
  });
  await fire(f, sc);
  const delay = f.store.state.schedules[sc.id].at - Date.now();
  assert.ok(delay > 250_000 && delay <= 300_000, `${delay} ms`);
  f.rt.cancelSchedule(sc.id);
});

test('#466 retries stop after an hour and leave one visible schedule line', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check the run.' });
  sc.firstFailureAt = Date.now() - 60 * 60_000;
  f.store.emit('schedule', sc);
  f.adapter.next.push(async () => {
    throw networkError('ECONNRESET');
  });
  await fire(f, sc);

  assert.equal(f.store.state.schedules[sc.id], undefined, 'no retry remains pending');
  assert.equal(f.rt.timers.has(sc.id), false);
  const line = f.store.item(sc.threadId, sc.itemId);
  assert.equal(line.retryStopped, true);
  assert.equal(line.retryAttempt, 1);
  assert.equal(f.store.items(sc.threadId).filter((item) => item.kind === 'system' && item.variant === 'wake').length, 1);
});

test('#466 a network failure after a tool started runs a recovery turn instead of replaying the wake', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Deploy and report.' });
  f.adapter.next.push(async (ctx) => {
    ctx.toolUse({ id: 'tool-1', name: 'Deploy', input: { stage: 'test' } });
    throw networkError('ECONNRESET');
  });
  await fire(f, sc);

  const recovery = f.store.state.schedules[sc.id];
  assert.ok(recovery, 'one recovery turn is pending under the schedule id');
  assert.ok(f.rt.timers.has(sc.id));
  clearTimeout(f.rt.timers.get(sc.id));
  f.adapter.next.push(async (ctx) => ctx.text('I checked the deployment before continuing.'));
  await fire(f, recovery);

  assert.equal(f.adapter.calls.length, 2);
  const message = f.adapter.calls[1].message;
  assert.equal(message.scheduledWakeId, sc.id);
  assert.notEqual(message.note, sc.note, 'the original instruction was not replayed');
  assert.match(message.note, /last scheduled turn.*network/i);
  assert.match(message.note, /Deploy/);
  assert.match(message.note, /Check what.*before you continue/i);
  assert.equal(f.store.state.schedules[sc.id], undefined);
});
