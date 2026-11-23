// #337: show_app and update_app wait for the version’s check while a Postbox page can run it, and their reply carries
// the result, so an agent doesn’t tell the person a version is fixed before its check fails it. A result the reply
// carries isn’t sent again as a message; one the wait gave up on still comes as one. With no page open, the reply
// returns at once.
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { awaited, checkLine, withCheck } from '../server/app-check-wait.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { settle } from './blocks-fixture.mjs';

/** The check’s finding the agent fixes, as the page reports it (app/kit/check-text.js). */
const FAINT = { code: 'low-contrast', message: 'Text contrast 1.79:1 in the subtitle (needs 4.5:1).' };
const WARNING = { code: 'marks-too-small', message: 'Some marks are smaller than 8 px.' };

function shown({ viewing = true } = {}) {
  const store = new Store(null);
  /** @type {any[]} */
  const heard = [];
  let onDeliver = async () => {};
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {},
      fork() {},
      async deliver(s, m, ctx) {
        heard.push(m);
        await onDeliver(s, m, ctx);
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'reviewer' }).id] });
  if (viewing) rt.threads.view(t.id);
  const se = arrange.agentIn(rt, t.id, 'reviewer');
  const tools = rt.toolsFor(se.id);
  const r = tools.show_app({ title: 'Paper #6', code: '<p>v1</p>' });
  const sent = () => heard.filter((m) => m.kind === 'app-check');
  const lints = () => heard.filter((m) => m.kind === 'lint');
  return {
    rt,
    t,
    se,
    tools,
    r,
    sent,
    lints,
    setDeliver(fn) {
      onDeliver = fn;
    },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#337 with a page open, the reply waits for the check through handleMcp and carries the problems it found, which no message repeats', async () => {
  const s = shown();
  let mcpText = '';
  s.setDeliver(async () => {
    const token = arrange.turnToken(s.rt, s.se.id);
    const call = handleMcp(
      s.rt,
      s.se.id,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_app', arguments: { id: s.r.appId, code: '<p>v2</p>' } } },
      token,
    );
    await sleep(5);
    assert.equal(awaited(s.rt.apps, s.r.appId, 2), true, 'the check knows a reply waits for it');
    s.rt.appCheck(s.r.appId, { version: 2, problems: [FAINT] });
    const res = await call;
    mcpText = res.result.content[0].text;
  });
  s.rt.sendMessage(s.t.id, { text: '@reviewer update' });
  await settle(s.rt);
  assert.doesNotMatch(mcpText, /browser check: pending\. This does not confirm a rendered result\./);
  assert.match(
    mcpText,
    /v2’s check found problems, so the person doesn’t see it yet\. Fix them in a new version\. Don’t tell the person v2 is fixed until its check passes\.\n- low-contrast: Text contrast 1\.79:1/,
  );
  assert.equal(s.rt.apps.waiting.size, 0, 'the wait map cleaned up');
  await sleep(20);
  assert.deepEqual(s.sent(), [], 'no app-check message repeats it');
});

test('#337 a check that takes longer than the wait: the reply says problems come as a message and read_message reads the result', async () => {
  const s = shown();
  const r = await withCheck(s.rt.apps, 'show_app', s.r, null, null, 30);
  assert.match(
    r.message,
    new RegExp(
      `v1’s check is still running; problems come to you as a message, and read_message \\{ id: "${s.r.appId}" \\} reads the result\\. Don’t tell the person v1 is fixed until its check passes\\.`,
    ),
  );
  assert.equal(awaited(s.rt.apps, s.r.appId, 1), false);
  assert.equal(s.rt.apps.waiting.size, 0);
  s.rt.appCheck(s.r.appId, { version: 1, problems: [FAINT] });
  for (let i = 0; i < 50 && !s.sent().length; i++) await sleep(5);
  assert.deepEqual(
    s.sent().map((m) => m.problems.map((p) => p.code)),
    [['low-contrast']],
  );
});

test('#337 stopping the turn during the wait releases the wait and sends a late failed check as a message instead of leaving the app fixing', async () => {
  const s = shown();
  let callPromise;
  let started = false;
  s.setDeliver(async (_se, m, ctx) => {
    if (m.kind === 'app-check') return;
    const token = arrange.turnToken(s.rt, s.se.id);
    // Pass a response that never closes on its own, so only the turn’s stop signal releases the wait.
    const res = new EventEmitter();
    callPromise = handleMcp(
      s.rt,
      s.se.id,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_app', arguments: { id: s.r.appId, code: '<p>v2</p>' } } },
      token,
      /** @type {any} */ (res),
    );
    started = true;
    await new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }))));
  });
  s.rt.sendMessage(s.t.id, { text: '@reviewer update' });
  for (let i = 0; i < 50 && (!started || !awaited(s.rt.apps, s.r.appId, 2)); i++) await sleep(5);
  assert.equal(awaited(s.rt.apps, s.r.appId, 2), true);
  // Stop the turn while update_app is still waiting for v2’s check.
  const stoppedAt = Date.now();
  s.rt.requestStop(s.se.id);
  const reply = await callPromise;
  assert.ok(Date.now() - stoppedAt < 2000, 'the stop releases it, not the wait’s own 12 s timer');
  assert.match(reply.result.content[0].text, /v2’s check is still running/);
  assert.equal(awaited(s.rt.apps, s.r.appId, 2), false);
  await settle(s.rt);
  // Now the browser reports a failed check for v2: it isn’t marked heard, so an app-check message is sent.
  s.rt.appCheck(s.r.appId, { version: 2, problems: [FAINT] });
  for (let i = 0; i < 50 && !s.sent().length; i++) await sleep(5);
  assert.equal(s.sent().length, 1, 'the failed check arrives as an app-check message');
  await settle(s.rt);
  assert.equal(s.rt.s.apps[s.r.appId].check.status, 'note', 'the app-check turn finished and moved the app out of fixing');
});

test('#337 a check a reply waits for in an ended turn is not heard by the next turn: it comes as a message', async () => {
  const s = shown();
  let turns = 0;
  /** @type {(() => void) | null} */
  let endB = null;
  s.setDeliver(async (_se, m) => {
    if (m.kind === 'app-check') return;
    turns++;
    if (turns === 1) {
      // Turn A calls update_app and ends while the call still waits: its response never closes.
      const token = arrange.turnToken(s.rt, s.se.id);
      const res = new EventEmitter();
      const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_app', arguments: { id: s.r.appId, code: '<p>v2</p>' } } };
      void handleMcp(s.rt, s.se.id, call, token, /** @type {any} */ (res));
      for (let i = 0; i < 50 && !awaited(s.rt.apps, s.r.appId, 2); i++) await sleep(5);
      return;
    }
    // Turn B runs until the test ends it.
    await new Promise((r) => {
      endB = () => r(undefined);
    });
  });
  s.rt.sendMessage(s.t.id, { text: '@reviewer update' });
  await settle(s.rt);
  assert.equal(awaited(s.rt.apps, s.r.appId, 2), true, 'turn A’s reply still waits');
  s.rt.sendMessage(s.t.id, { text: '@reviewer next' });
  for (let i = 0; i < 50 && !endB; i++) await sleep(5);
  assert.ok(endB, 'turn B is running');
  s.rt.appCheck(s.r.appId, { version: 2, problems: [FAINT] });
  assert.equal(s.rt.s.apps[s.r.appId].check.heard, undefined, 'turn B never saw the check');
  assert.equal(awaited(s.rt.apps, s.r.appId, 2), false, 'turn A’s wait has the result');
  /** @type {any} */ (endB)();
  for (let i = 0; i < 100 && !s.sent().length; i++) await sleep(5);
  assert.equal(s.sent().length, 1, 'it comes as an app-check message once turn B ends');
  await settle(s.rt);
});

test('#337 an already-aborted signal, an already-closed response, or a closing socket releases the wait without waiting for the timer', async () => {
  const s = shown();
  const ac = new AbortController();
  ac.abort();
  const started = Date.now();
  const r1 = await withCheck(s.rt.apps, 'show_app', s.r, ac.signal, null, 10_000);
  assert.ok(Date.now() - started < 500, 'already-aborted signal returns at once');
  assert.match(r1.message, /still running/);
  assert.equal(s.rt.apps.waiting.size, 0);

  const res = new EventEmitter();
  const p = withCheck(s.rt.apps, 'show_app', s.r, res, null, 10_000);
  assert.equal(awaited(s.rt.apps, s.r.appId, 1), true);
  res.emit('close');
  const r2 = await p;
  assert.ok(Date.now() - started < 500, 'closing socket releases the wait at once');
  assert.match(r2.message, /still running/);
  assert.equal(s.rt.apps.waiting.size, 0);
});

test('#337 a settled wait leaves no listener on the turn’s signal or the response', async () => {
  const s = shown();
  const ac = new AbortController();
  const res = new EventEmitter();
  // Three waits that time out, as calls in one turn would.
  for (let i = 0; i < 3; i++) assert.match((await withCheck(s.rt.apps, 'show_app', s.r, [ac.signal, res], null, 5)).message, /still running/);
  assert.deepEqual([getEventListeners(ac.signal, 'abort').length, res.listenerCount('close')], [0, 0]);
});

test('#337 a result that arrived before the wait starts returns at once, and warnings carried by the reply do not trigger a duplicate lint turn', async () => {
  const s = shown();
  s.rt.appCheck(s.r.appId, { version: 1, problems: [] });
  const started = Date.now();
  const passed = await withCheck(s.rt.apps, 'show_app', s.r, null, null, 10_000);
  assert.ok(Date.now() - started < 500);
  assert.match(passed.message, /v1 passed its check, and the person sees it\./);

  // Warnings while a reply waits on a live turn: carried in the reply, told: true, and no lint turn repeats them.
  let replyText = '';
  s.setDeliver(async () => {
    const r = s.tools.update_app({ id: s.r.appId, code: '<p>v2</p>' });
    const p = withCheck(s.rt.apps, 'update_app', r, null, s.rt.turns.get(s.se.id));
    s.rt.appCheck(s.r.appId, { version: 2, problems: [WARNING] });
    replyText = (await p).message;
  });
  s.rt.sendMessage(s.t.id, { text: '@reviewer v2' });
  await settle(s.rt);
  assert.match(replyText, /v2 is shown, with these notes from its check:\n- marks-too-small/);
  assert.equal(s.rt.s.apps[s.r.appId].check.told, true);
  await sleep(20);
  assert.deepEqual(s.lints(), [], 'no lint turn repeats the warning carried in the reply');
  const queued = [...s.rt.checks.lints.values()].flatMap((e) => e.problems);
  assert.deepEqual(queued, [], 'and none is queued for one');
});

test('#337 with no page open, the reply returns at once, as before', async () => {
  const s = shown({ viewing: false });
  const r = await withCheck(s.rt.apps, 'show_app', s.r, null);
  assert.equal(r, s.r);
  assert.equal(awaited(s.rt.apps, s.r.appId, 1), false);
});

test('#337 the reply’s line for each result: passed, warnings, second failure, and crashed', () => {
  assert.equal(checkLine(3, { status: 'passed', problems: [] }), 'v3 passed its check, and the person sees it.');
  assert.equal(
    checkLine(3, { status: 'note', notes: true, problems: [WARNING] }),
    'v3 is shown, with these notes from its check:\n- marks-too-small: Some marks are smaller than 8 px.',
  );
  assert.equal(
    checkLine(3, { status: 'note', problems: [FAINT] }),
    'v3 still has problems from its check, so it is shown with a note:\n- low-contrast: Text contrast 1.79:1 in the subtitle (needs 4.5:1).',
  );
  assert.match(checkLine(3, { status: 'crashed', problems: [{ code: 'script-error', message: 'x is not defined' }] }), /^v3 still fails with a script error/);
});

test('#337 a fix the reply carried ends with the turn that heard it, while an un-heard fix stays fixing for its app-check turn', async () => {
  const s = shown();
  // Create a second app whose check fails with no reply waiting (heard is not set): ending the turn with heardOnly must leave it fixing.
  const other = s.tools.show_app({ id: 'other', title: 'Other', code: '<p>other</p>' });
  s.rt.store.emit('app', { ...s.rt.s.apps[other.appId], check: { status: 'fixing', attempt: 1, problems: [FAINT] } });
  s.setDeliver(async (_session, _message, ctx) => {
    const r = ctx.tools.update_app({ id: s.r.appId, code: '<p>v2</p>', summary: 'bigger labels' });
    const reply = withCheck(s.rt.apps, 'update_app', r, null, s.rt.turns.get(s.se.id));
    s.rt.appCheck(s.r.appId, { version: 2, problems: [FAINT] });
    await reply;
  });
  s.rt.sendMessage(s.t.id, { text: '@reviewer fix it' });
  for (let i = 0; i < 100 && s.rt.s.apps[s.r.appId].check.status !== 'note'; i++) await sleep(10);
  await settle(s.rt);
  assert.equal(s.rt.s.apps[s.r.appId].check.status, 'note', 'out of fixing once the turn that heard it ended');
  assert.equal(s.rt.s.apps[other.appId].check.status, 'fixing', 'an app whose fix was not heard in the reply stays fixing');
  assert.deepEqual(s.sent(), [], 'no app-check message');
});

test('#337 a reply waiting for a version that a newer one replaced, or whose app was retired, hears so at once', async () => {
  const s = shown();
  const v1 = withCheck(s.rt.apps, 'show_app', s.r, null);
  const u = s.tools.update_app({ id: s.r.appId, code: '<p>v2</p>', summary: 'again' });
  assert.match((await v1).message, /v1 was replaced by a newer version before its check ran\./);
  const v2 = withCheck(s.rt.apps, 'update_app', u, null);
  s.tools.retire_app({ id: s.r.appId, reason: 'Replaced.' });
  assert.match((await v2).message, /The app was retired before v2’s check ran\./);
});

test('#337 only a page in view counts: one that pinged a conversation in the last 20 seconds', () => {
  const s = shown({ viewing: false });
  assert.equal(s.rt.threads.anyViewing(), false, 'no page has pinged');
  s.rt.threads.view(s.t.id);
  assert.equal(s.rt.threads.anyViewing(), true);
  s.rt.threads.viewing.set(s.t.id, Date.now() - 21_000);
  assert.equal(s.rt.threads.anyViewing(), false, 'a page that stopped pinging, as a background tab does');
});
