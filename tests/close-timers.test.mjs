// A Postbox that has closed starts no turn. A lint turn waits LINT_SETTLE_MS after the turn it reports on, on a timer
// close() didn’t clear: it fired after the store had closed, delivered, and logged “@x’s turn waits: Postbox can’t save
// changes right now” into whatever ran next (the strict server-log guard found it in the browser specs). Every timer
// the runtime starts is cleared by close.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { sendLint } from '../server/lint-delivery.mjs';
import { captureServerLog, takeServerFailures } from './server-log.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');
captureServerLog();

/** A Postbox with one agent in one conversation, and a spy on its deliveries. */
async function app() {
  const dir = tempDir('pb-close-timers-');
  const a = await start({ port: 4465, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  a.store.emit('project', { id: 'p1', name: 'P', folder: dir });
  const p = a.rt.createPersona({ handle: 'linted', backend: 'mock' });
  const t = a.rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = a.rt.sessionsIn(t.id)[0];
  const delivered = [];
  const deliver = a.rt.deliver.bind(a.rt);
  a.rt.deliver = (...args) => {
    delivered.push(args[0]);
    return deliver(...args);
  };
  return { a, t, se, delivered };
}

test('a lint turn due just after close() isn’t delivered, and nothing is logged', async () => {
  const { a, t, se, delivered } = await app();
  a.rt.config.lintSettleMs = 20;
  a.rt.lints.set('turn_1', {
    sessionId: se.id,
    kind: 'turn',
    ended: true,
    sent: false,
    problems: [{ code: 'x', message: 'A problem.', scope: { kind: 'reply' } }],
    timer: null,
    threadId: t.id,
  });
  sendLint(a.rt, 'turn_1');
  await a.close();
  await sleep(80); // past the lint’s settle time
  assert.deepEqual(delivered, [], 'nothing was delivered after close');
  assert.deepEqual(takeServerFailures(), [], 'and nothing was logged');
});

test('a stopped turn’s watchdog, which starts its next turn, doesn’t fire after close()', async () => {
  const { a } = await app();
  let fired = false;
  try {
    a.rt.watchdogs.add(setTimeout(() => (fired = true), 20).unref());
  } finally {
    await a.close();
  }
  await sleep(60);
  assert.equal(fired, false, 'close cleared it');
  assert.equal(a.rt.watchdogs.size, 0);
  assert.deepEqual(takeServerFailures(), []);
});

// The work ledger records a turn’s end after the turn stops: it reads each file the turn changed, then patches the
// turn’s entry. A shutdown stopped the turns and closed the store without waiting for that, so the patch landed on a
// closed store, which dropped it and logged “An event after the store closed was dropped” (ring-context.spec’s stop).
test('the work ledger’s record of a turn that just stopped lands before the store closes', async () => {
  const { a } = await app();
  a.store.emit('work.add', { convId: 'th_w', entry: { id: 'wk_1', kind: 'turn', status: 'running' } });
  let patched = false;
  a.rt.ledger.track(
    sleep(30).then(() => {
      a.rt.ledger.patch('th_w', 'wk_1', { status: 'stopped' });
      patched = true;
    }),
  );
  await a.close();
  assert.equal(patched, true, 'the record landed before close() returned');
  assert.deepEqual(takeServerFailures(), [], 'and nothing was dropped or logged');
});

// close() stops the hosts after the turns, and a remote turn that ends then can arm a lint or a summary: stopTimers runs
// once more after the hosts have stopped.
test('a lint turn armed while the hosts stop isn’t delivered after close()', async () => {
  const { a, t, se, delivered } = await app();
  a.rt.config.lintSettleMs = 20;
  const close = a.rt.hosts.close.bind(a.rt.hosts);
  a.rt.hosts.close = async () => {
    a.rt.lints.set('turn_h', {
      sessionId: se.id,
      kind: 'turn',
      ended: true,
      sent: false,
      problems: [{ code: 'x', message: 'A problem.', scope: { kind: 'reply' } }],
      timer: null,
      threadId: t.id,
    });
    sendLint(a.rt, 'turn_h');
    await close();
  };
  await a.close();
  await sleep(80); // past the lint’s settle time
  assert.deepEqual(delivered, [], 'nothing was delivered after close');
  assert.deepEqual(takeServerFailures(), [], 'and nothing was logged');
});

// A ledger record that never settles, such as a read of a file on a disk that stopped answering, mustn’t hold the
// shutdown: close() waits its grace for it (LEDGER_GRACE_MS, 4 s; a test sets it shorter), then goes on.
test('close() waits for a ledger record that never settles at most its grace, then closes', async () => {
  const { a } = await app();
  a.rt.config.ledgerGraceMs = 30;
  a.rt.ledger.track(new Promise(() => {}));
  const started = Date.now();
  await a.close();
  assert.ok(Date.now() - started >= 30, 'it waited for the record');
  assert.ok(Date.now() - started < 3000, 'and closed once its grace was over, not the default 4 s');
  assert.deepEqual(takeServerFailures(), []);
});
