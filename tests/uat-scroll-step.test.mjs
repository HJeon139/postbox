// The tester’s scroll (tools/uat/scroll-step.mjs) and the run’s record of every input it makes (facts.probes.inputs,
// tools/uat/probes.mjs; #531): the tester’s scrolls, and the runner’s own clicks, which scroll what they click into view.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { driver } from '../tools/uat/driver.mjs';
import { newProbes, recordInput } from '../tools/uat/probes.mjs';
import { savedFacts } from '../tools/uat/recheck.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { STEPS } from '../tools/uat/steps.mjs';
import { SCHEMA, systemPrompt } from '../tools/uat/tester.mjs';

/** A page that notes what reaches it, and how many inputs were recorded by then. */
const notingPage = (facts) => {
  const calls = [];
  const page = {
    evaluate: async (expression) => {
      calls.push({ evaluate: expression, inputs: facts.probes.inputs.length });
    },
    send: async (method, params) => {
      calls.push({ method, ...params, inputs: facts.probes.inputs.length });
    },
  };
  return { calls, page };
};

test('scroll records its input before anything reaches the page, then focuses the conversation and presses the key', async () => {
  const facts = { probes: newProbes() };
  const { calls, page } = notingPage(facts);
  await STEPS.scroll({ page, facts, step: 4 }, { by: 'up' });
  assert.deepEqual(facts.probes.inputs, [{ step: 4, at: facts.probes.inputs[0]?.at, kind: 'scroll' }]);
  assert.equal(typeof facts.probes.inputs[0].at, 'number');
  assert.ok(
    calls.every((c) => c.inputs === 1),
    'recorded before the focus and the key',
  );
  assert.match(calls[0].evaluate, /#main\.transcript/);
  assert.match(calls[0].evaluate, /focus\(\{ preventScroll: true \}\)/);
  assert.deepEqual(
    calls.slice(1).map((c) => [c.method, c.type, c.key, c.windowsVirtualKeyCode]),
    [
      ['Input.dispatchKeyEvent', 'keyDown', 'PageUp', 33],
      ['Input.dispatchKeyEvent', 'keyUp', 'PageUp', 33],
    ],
  );
});

test('scroll presses PageDown, End or Home for down, end and start, and refuses anything else before it records', async () => {
  for (const [by, key, code] of [
    ['down', 'PageDown', 34],
    ['end', 'End', 35],
    ['start', 'Home', 36],
  ]) {
    const facts = { probes: newProbes() };
    const { calls, page } = notingPage(facts);
    await STEPS.scroll({ page, facts, step: 1 }, { by });
    assert.deepEqual(
      calls.filter((c) => c.method).map((c) => [c.key, c.windowsVirtualKeyCode]),
      [
        [key, code],
        [key, code],
      ],
    );
  }
  const facts = { probes: newProbes() };
  const { calls, page } = notingPage(facts);
  await assert.rejects(STEPS.scroll({ page, facts, step: 1 }, { by: 'sideways' }), /Scroll up, down, end or start, not “sideways”/);
  assert.deepEqual(facts.probes.inputs, []);
  assert.deepEqual(calls, []);
});

test('the tester has scroll, with by, and is told what each does', () => {
  const action = SCHEMA.properties.action.properties;
  assert.ok(action.type.enum.includes('scroll'));
  assert.deepEqual(action.by.enum, ['up', 'down', 'end', 'start']);
  const prompt = systemPrompt({ scenario: parseScenario('# T\n'), issues: [] });
  assert.match(prompt, /- scroll \{by: up\|down\|end\|start\}: /);
  assert.match(prompt, /PageUp/);
});

test('the recorder stamps each input with the step it’s in, and logs a runner action that moved the view', () => {
  const probes = newProbes();
  const said = [];
  let step = 2;
  const input = recordInput(
    probes,
    () => step,
    (l) => said.push(l),
  );
  input({ kind: 'runner-click' });
  step = 3;
  const before = { where: 'main', mode: 'reading', anchor: 'it_a', offset: 40 };
  input({ cause: 'runner', where: 'main', before, after: { ...before, offset: 90 } });
  assert.deepEqual(
    probes.inputs.map(({ step, kind, cause }) => ({ step, kind, cause })),
    [
      { step: 2, kind: 'runner-click', cause: undefined },
      { step: 3, kind: undefined, cause: 'runner' },
    ],
  );
  assert.ok(probes.inputs.every((x) => typeof x.at === 'number'));
  assert.equal(said.length, 1);
  assert.match(said[0], /moved the main view/);
});

test('a run saved before inputs were recorded still loads, with none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-inputs-'));
  try {
    const facts = savedFacts(dir, { state: { threads: {} }, mainId: 't1', saved: { probes: { answers: [] } }, logs: [], hostsRec: null, record: null });
    assert.deepEqual(facts.probes.inputs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a runner click is recorded before it scrolls what it clicks into view', async () => {
  const facts = { probes: newProbes() };
  const order = [];
  const page = {
    evaluate: async () => {
      order.push(`scroll after ${facts.probes.inputs.length}`);
      return { x: 10, y: 10 };
    },
    send: async () => {},
  };
  const d = driver(page, {
    input: recordInput(
      facts.probes,
      () => 5,
      () => {},
    ),
  });
  await d.clickAt(`document.body`, 'the page');
  assert.deepEqual(
    facts.probes.inputs.map((x) => [x.step, x.kind]),
    [[5, 'runner-click']],
  );
  assert.deepEqual(order, ['scroll after 1']);
});
