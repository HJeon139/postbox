// The daemon’s broker (server/remote/host/broker.mjs, #120), driven in-process: Codex’s approvals, declined on the held
// stdin at permissionWaitMax. A shim is a pair of functions, Postbox is a list of what the broker sent it, and the turn
// folders are in a temp home (tests/remote-broker-fixtures.mjs). Nothing is spawned; the real daemon, runner and shim
// are in tests/integration/remote-broker.test.mjs.

import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CODEX_DECLINE, codexDeclineLine, codexPromptId } from '../server/remote/host/broker.mjs';
import { HOST_DEFAULTS, TURN_FILES } from '../shared/remote-protocol.mjs';
import { fakeClock, lines, makeBroker, makeHome, until } from './remote-broker-fixtures.mjs';

// ── Codex approvals ──

// Recorded shapes: the requests server/adapters/codex.mjs answers in codexApproval.
const RECORDED = [
  '{"method":"turn/started","params":{"turn":{"id":"u1"}}}',
  '{"id":7,"method":"item/commandExecution/requestApproval","params":{"itemId":"i1","command":"rm -rf build"}}',
  '{"id":8,"method":"item/fileChange/requestApproval","params":{"itemId":"i2"}}',
  '{"id":"e9","method":"mcpServer/elicitation/request","params":{"serverName":"github","message":"Allow?"}}',
  '{"id":3,"result":{}}',
  '',
].join('\n');

/**
 * The first test’s second daemon, after the first one closed: what it knows from the records, and what it watches.
 * @param {ReturnType<typeof makeHome>} h @param {ReturnType<typeof fakeClock>} clock @param {any} k @param {string} out @param {number} wait
 */
async function codexRestarted(h, clock, k, out, wait) {
  // A restarted daemon knows when it first saw a request, and what it declined.
  await appendFile(out, '{"id":11,"method":"item/commandExecution/requestApproval","params":{}}\n');
  await clock.tick(1000);
  await clock.tick(30_000);
  k.b.close();
  const again = makeBroker(h, { now: clock.now, timers: clock.timers, codexPollMs: 1000, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) });
  await again.b.load([{ turn: 'cx', state: 'running' }]);
  assert.deepEqual(again.writes, [], 'requests 7 and e9 were declined already, and 11 is new');
  await clock.tick(wait - 30_000 - 1);
  assert.deepEqual(again.writes, []);
  // The fake clock runs a timer at the end of its tick, so the next look is a poll interval on, still well before
  // permissionWaitMax from this daemon’s start.
  await clock.tick(1000);
  assert.deepEqual(
    again.writes.map((w) => JSON.parse(w.line).id),
    [11],
    'declined permissionWaitMax after the first daemon saw it',
  );
  // A turn that has ended isn’t watched any more.
  writeFileSync(h.p.turn('cx', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
  await clock.tick(1000);
  assert.deepEqual(again.b.pending.watches, []);
  // Only held Codex turns are watched.
  h.turn('cc');
  await again.b.started('cc');
  assert.deepEqual(again.b.pending.watches, []);
  again.b.close();
  assert.equal(codexPromptId(7), 'codex:7');
  assert.equal(codexPromptId('x'.repeat(200)), null);
}

test('Codex: a request nobody answers is declined on the held stdin at permissionWaitMax, and Postbox hears it expired', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('cx', { harness: 'codex', stdin: 'held' });
    const out = h.p.turn('cx', TURN_FILES.out);
    const inn = h.p.turn('cx', TURN_FILES.in);
    const wait = 60_000;
    const k = makeBroker(h, { now: clock.now, timers: clock.timers, codexPollMs: 1000, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) });
    writeFileSync(out, RECORDED);
    await k.b.started('cx');
    assert.deepEqual(k.b.pending.watches, ['cx']);
    // Postbox answers 8 through the daemon’s write; the runner appends it to in.jsonl.
    const check = k.b.checkWrite('cx', '{"id":8,"result":{"decision":"accept"}}');
    assert.ok('done' in check);
    check.done(true);
    writeFileSync(inn, '{"id":8,"result":{"decision":"accept"}}\n');
    // Noted, so a restart doesn’t take a denial of Postbox’s in in.jsonl for the daemon’s own decline.
    await until(() => lines(h.p.turn('cx', TURN_FILES.prompts)).some((x) => x.op === 'codex-answered' && x.id === 'codex:8'), 'Postbox’s answer’s note');
    await clock.tick(wait - 1000);
    assert.deepEqual(k.writes, [], 'not yet');
    // Half a line now, the rest later: a request is read only once it’s whole.
    await appendFile(out, '{"id":10,"method":"item/commandExecution/req');
    await clock.tick(1000);
    assert.deepEqual(
      k.writes.map((w) => w.line).sort(),
      [codexDeclineLine('item/commandExecution/requestApproval', 7), codexDeclineLine('mcpServer/elicitation/request', 'e9')].sort(),
    );
    assert.deepEqual(JSON.parse(codexDeclineLine('mcpServer/elicitation/request', 'e9')), { id: 'e9', result: { action: 'decline' } });
    assert.deepEqual(JSON.parse(codexDeclineLine('item/fileChange/requestApproval', 1)).result, CODEX_DECLINE['item/fileChange/requestApproval']);
    assert.deepEqual(
      k.sent.map((m) => [m.type, m.id, m.reason]).sort(),
      [
        ['prompt-expired', 'codex:e9', 'expired'],
        ['prompt-expired', 'codex:7', 'expired'],
      ].sort(),
    );
    // A late answer to a declined request is refused: Codex gets one answer to each.
    const late = k.b.checkWrite('cx', '{"id":7,"result":{"decision":"accept"}}');
    assert.ok('refused' in late);
    assert.match(late.refused, /was declined at the host’s permissionWaitMax/);
    // The request finished writing, and turn/completed ends it without a decline.
    await appendFile(out, 'uestApproval","params":{}}\n');
    await clock.tick(1000);
    await appendFile(out, '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n');
    await clock.tick(wait);
    assert.equal(k.writes.length, 2);
    await codexRestarted(h, clock, k, out, wait);
  } finally {
    h.done();
  }
});

const ACCEPT_7 = '{"id":7,"result":{"decision":"accept"}}';
const REQUEST_7 = '{"id":7,"method":"item/commandExecution/requestApproval","params":{"command":"ls"}}';

test('Codex: a daemon that dies before its decline reaches the held stdin leaves the request waiting, and the next one declines it', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('cx', { harness: 'codex', stdin: 'held' });
    const wait = 60_000;
    const opts = { now: clock.now, timers: clock.timers, codexPollMs: 1000, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) };
    writeFileSync(h.p.turn('cx', TURN_FILES.out), `${REQUEST_7}\n`);
    let tries = 0;
    // The daemon dies as it hands the decline to the runner: nothing reaches in.jsonl, so Codex never got it.
    const k = makeBroker(h, {
      ...opts,
      writeStdin: () => {
        tries++;
        return new Promise(() => {});
      },
    });
    await k.b.started('cx');
    void clock.tick(wait);
    await until(() => tries, 'the decline to start');
    assert.deepEqual(k.sent, [], 'Postbox hears nothing before Codex has the decline');
    k.b.close();
    // The next daemon finds the request unanswered in in.jsonl, so it still waits, and it’s past permissionWaitMax
    // from when the first daemon saw it: declined as the turn is watched again.
    const again = makeBroker(h, opts);
    await again.b.load([{ turn: 'cx', state: 'running' }]);
    assert.deepEqual(
      again.writes.map((w) => w.line),
      [codexDeclineLine('item/commandExecution/requestApproval', 7)],
    );
    assert.deepEqual(
      again.sent.map((m) => [m.type, m.id, m.reason]),
      [['prompt-expired', 'codex:7', 'expired']],
    );
    const late = again.b.checkWrite('cx', ACCEPT_7);
    assert.ok('refused' in late, 'Codex gets one answer to it');
    assert.match(late.refused, /was declined at the host’s permissionWaitMax/);
    await clock.tick(wait);
    assert.equal(again.writes.length, 1, 'declined once');
    again.b.close();
  } finally {
    h.done();
  }
});

test('Codex: a decline the runner doesn’t take leaves the request waiting, with nothing sent to Postbox, and the next look declines it', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('cx', { harness: 'codex', stdin: 'held' });
    const inn = h.p.turn('cx', TURN_FILES.in);
    const wait = 60_000;
    let down = true;
    /** @type {string[]} */
    const went = [];
    const k = makeBroker(h, {
      now: clock.now,
      timers: clock.timers,
      codexPollMs: 1000,
      settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }),
      writeStdin: async (_turn, line) => {
        if (down) throw new Error('the runner went away');
        went.push(line);
        await appendFile(inn, `${line}\n`);
        return statSync(inn).size;
      },
    });
    writeFileSync(h.p.turn('cx', TURN_FILES.out), `${REQUEST_7}\n`);
    await k.b.started('cx');
    await clock.tick(wait);
    assert.deepEqual(k.sent, [], 'no expiry: Codex didn’t get the decline');
    assert.match(k.logs.join('\n'), /Couldn’t decline Codex’s request 7 in turn cx: the runner went away/);
    // It waits again: Postbox may still answer it (this write didn’t go either).
    const check = k.b.checkWrite('cx', ACCEPT_7);
    assert.ok('done' in check, 'Postbox may still answer it');
    check.done(false);
    down = false;
    await clock.tick(1000);
    assert.deepEqual(went, [codexDeclineLine('item/commandExecution/requestApproval', 7)], 'declined at the next look');
    assert.deepEqual(
      k.sent.map((m) => [m.type, m.id, m.reason]),
      [['prompt-expired', 'codex:7', 'expired']],
    );
    assert.ok('refused' in k.b.checkWrite('cx', ACCEPT_7));
    await until(() => lines(h.p.turn('cx', TURN_FILES.prompts)).some((x) => x.op === 'expiry-sent'), 'the expiry’s record');
    k.b.close();
    // A restarted daemon refuses a late answer to it, and has nothing more to tell Postbox.
    const again = makeBroker(h, { now: clock.now, timers: clock.timers, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) });
    await again.b.load([{ turn: 'cx', state: 'running' }]);
    assert.ok('refused' in again.b.checkWrite('cx', ACCEPT_7));
    assert.deepEqual(await again.hello(), []);
    assert.deepEqual(again.writes, []);
    again.b.close();
  } finally {
    h.done();
  }
});

test('Codex: in.jsonl says what Codex got: after a restart a decline there still owes Postbox its expiry, and no request answered there takes another answer', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('cx', { harness: 'codex', stdin: 'held' });
    const wait = 60_000;
    const opts = { now: clock.now, timers: clock.timers, codexPollMs: 1000, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) };
    const request = (id) => JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } });
    writeFileSync(h.p.turn('cx', TURN_FILES.out), `${[7, 8, 9].map(request).join('\n')}\n`);
    // A daemon declined 7 and died before Postbox heard; Postbox denied 8 itself (codexApproval’s same line) and 9 it allowed.
    const decline = (id) => codexDeclineLine('item/commandExecution/requestApproval', id);
    writeFileSync(h.p.turn('cx', TURN_FILES.in), `${decline(7)}\n${decline(8)}\n{"id":9,"result":{"decision":"accept"}}\n`);
    writeFileSync(h.p.turn('cx', TURN_FILES.prompts), `${JSON.stringify({ op: 'codex-answered', id: 'codex:8', at: 1 })}\n`);
    const k = makeBroker(h, opts);
    k.state.attached = false;
    await k.b.load([{ turn: 'cx', state: 'running' }]);
    k.state.attached = true;
    const hello = await k.hello();
    assert.deepEqual(
      hello.map((m) => [m.type, m.id, m.reason]),
      [['prompt-expired', 'codex:7', 'expired']],
      'only the host’s own decline was unsent',
    );
    for (const id of [7, 8, 9]) assert.ok('refused' in k.b.checkWrite('cx', JSON.stringify({ id, result: { decision: 'accept' } })), `a later answer to ${id}`);
    await clock.tick(wait);
    assert.deepEqual(k.writes, [], 'nothing is declined again');
    assert.deepEqual(await k.hello(), [], 'an expiry is sent once');
    await until(() => lines(h.p.turn('cx', TURN_FILES.prompts)).some((x) => x.op === 'expiry-sent'), 'the expiry’s record');
    k.b.close();
    const again = makeBroker(h, opts);
    await again.b.load([{ turn: 'cx', state: 'running' }]);
    assert.deepEqual(await again.hello(), [], 'and not after the next restart');
    again.b.close();
  } finally {
    h.done();
  }
});
