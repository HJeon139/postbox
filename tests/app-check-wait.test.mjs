// #337: show_app and update_app wait for the version’s check while a Postbox page can run it, and their reply carries
// the result, so an agent doesn’t tell the person a version is fixed before its check fails it. A result the reply
// carries isn’t sent again as a message; one the wait gave up on still comes as one. With no page open, the reply
// returns at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { awaited, checkLine, checksRunIn, withCheck } from '../server/app-check-wait.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

/** The check’s finding the agent fixes, as the page reports it (app/kit/check-text.js). */
const FAINT = { code: 'low-contrast', message: 'Text contrast 1.79:1 in the subtitle (needs 4.5:1).' };

function shown() {
  const store = new Store(null);
  /** @type {any[]} */
  const heard = [];
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {},
      fork() {},
      async deliver(_s, m) {
        heard.push(m);
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'reviewer' }).id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id, 'reviewer').id);
  const r = tools.show_app({ title: 'Paper #6', code: '<p>v1</p>' });
  const sent = () => heard.filter((m) => m.kind === 'app-check');
  return { rt, tools, r, sent };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#337 with a page open, the reply waits for the check and carries the problems it found, which no message repeats', async () => {
  const s = shown();
  checksRunIn(() => true);
  try {
    const reply = withCheck('show_app', s.r, null);
    assert.equal(awaited(s.r.appId, 1), true, 'the check knows a reply waits for it');
    s.rt.appCheck(s.r.appId, { version: 1, problems: [FAINT] });
    const r = await reply;
    assert.equal(r.check.status, 'fixing');
    assert.match(
      r.message,
      /v1’s check found problems, so the person doesn’t see it yet\. Fix them in a new version\. Don’t tell the person v1 is fixed until its check passes\.\n- low-contrast: Text contrast 1\.79:1/,
    );
    await sleep(20);
    assert.deepEqual(s.sent(), [], 'no app-check message repeats it');
  } finally {
    checksRunIn(() => false);
  }
});

test('#337 a check that takes longer than the wait: the reply says it’s still running, and the result comes as a message', async () => {
  const s = shown();
  checksRunIn(() => true);
  try {
    const r = await withCheck('show_app', s.r, null, 30);
    assert.match(r.message, /v1’s check is still running; its result comes to you as a message\. Don’t tell the person v1 is fixed until its check passes\./);
    assert.equal(awaited(s.r.appId, 1), false);
    s.rt.appCheck(s.r.appId, { version: 1, problems: [FAINT] });
    for (let i = 0; i < 50 && !s.sent().length; i++) await sleep(5);
    assert.deepEqual(
      s.sent().map((m) => m.problems.map((p) => p.code)),
      [['low-contrast']],
    );
  } finally {
    checksRunIn(() => false);
  }
});

test('#337 with no page open, the reply returns at once, as before', async () => {
  const s = shown();
  const r = await withCheck('show_app', s.r, null);
  assert.equal(r, s.r);
  assert.equal(awaited(s.r.appId, 1), false);
});

test('#337 the reply’s line for each result', () => {
  assert.equal(checkLine(3, { status: 'passed', problems: [] }), 'v3 passed its check, and the person sees it.');
  assert.equal(
    checkLine(3, { status: 'note', problems: [FAINT] }),
    'v3 is shown, with these notes from its check:\n- low-contrast: Text contrast 1.79:1 in the subtitle (needs 4.5:1).',
  );
  assert.match(checkLine(3, { status: 'crashed', problems: [{ code: 'script-error', message: 'x is not defined' }] }), /^v3 still fails with a script error/);
});
