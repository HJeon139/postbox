// #952: a finding only the agent hears. Labels on a chart's marks are told to the agent through the lint pipeline,
// and alone they leave the version passed, with no note for the person. With another warning, the version has its
// note as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { appCheckText } from '../server/app-check-status.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const HINT = { code: 'text-over-marks', message: 'In svg#runs, 1 label sits on the chart’s marks, such as “6:25” (on a dot).' };
const WARNING = { code: 'marks-too-small', message: 'Some marks are smaller than 8 px.' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An agent's turn shows an app, and the page's check of it comes back while the turn runs, with these problems. Returns
 * the app's recorded check, the result appCheck gave, and the problems queued for the turn's lint, which the agent
 * hears once the turn ends (server/lint-delivery.mjs).
 * @param {any[]} problems
 */
async function checkedInTurn(problems) {
  const store = new Store(null);
  /** @type {any} */
  let result = null;
  /** @type {string} */
  let appId = '';
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {},
      fork() {},
      async deliver(se) {
        if (appId) return;
        appId = rt.toolsFor(se.id).show_app({ title: 'Runs', code: '<svg></svg>' }).appId;
        result = rt.appCheck(appId, { version: 1, problems });
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'drawer' }).id] });
  rt.sendMessage(t.id, { text: '@drawer chart the runs' });
  for (let i = 0; i < 100 && !result; i++) await sleep(5);
  const lints = [...rt.checks.lints.values()].flatMap((e) => e.problems);
  return { check: rt.store.state.apps[appId].check, read: appCheckText(rt.store.state.apps[appId]), result, lints };
}

test('#952 labels on a chart’s marks alone: the version passes, with no note for the person, and the agent is told', async () => {
  const { check, read, result, lints } = await checkedInTurn([HINT]);
  assert.deepEqual(result, { status: 'passed' });
  assert.equal(check.status, 'passed');
  assert.deepEqual(check.problems, [], 'nothing for the person');
  assert.deepEqual(check.hints, [HINT], 'kept on the check for the agent to read');
  assert.match(read, /Browser check: passed\.\n- text-over-marks: In svg#runs/, 'read_message names it to the agent');
  assert.deepEqual(
    lints.map((p) => [p.code, p.scope.kind]),
    [['text-over-marks', 'app']],
    'the agent hears it in the turn’s lint',
  );
});

test('#952 labels on a chart’s marks with another warning: the version has its note, as before, and the agent hears both', async () => {
  const { check, result, lints } = await checkedInTurn([HINT, WARNING]);
  assert.equal(result.status, 'note');
  assert.deepEqual(
    check.problems.map((p) => p.code),
    ['text-over-marks', 'marks-too-small'],
  );
  assert.deepEqual(lints.map((p) => p.code).sort(), ['marks-too-small', 'text-over-marks']);
});

test('#952 a check with no findings passes, and tells the agent nothing', async () => {
  const { check, result, lints } = await checkedInTurn([]);
  assert.deepEqual(result, { status: 'passed' });
  assert.equal(check.status, 'passed');
  assert.equal(check.hints, undefined);
  assert.deepEqual(lints, []);
});
