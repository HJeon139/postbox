// The tester’s scroll while an agent works (tools/uat/scroll-mid-turn.mjs, #805): an interrupt that makes each move
// as the scroll step does, the input first, and takes one view sample after each, all as the driver’s answer
// mid-turn. tests/browser/uat-scroll-mid-turn.spec.mjs drives it against a real page while a reply streams.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { MOVES_MAX, scrollMoves } from '../tools/uat/scroll-mid-turn.mjs';
import { interruptAct } from '../tools/uat/steps.mjs';
import { SCHEMA, systemPrompt } from '../tools/uat/tester.mjs';

/** What a read the scroll makes is: focusing the conversation, asking whether Stop shows, or waiting for it to hold still. */
function kindOf(expr) {
  if (expr.includes('focus(')) return 'focus';
  if (expr.includes('button.stop')) return 'working';
  return 'still';
}

/** A driver whose page notes each key and each read, with how many inputs and samples were recorded by then. */
function notingDriver(facts) {
  const calls = [];
  const note = (what) => calls.push({ what, inputs: facts.probes.inputs.length, views: (facts.probes.views ?? []).length });
  const sample = (mode) => [{ where: 'main', thread: 't1', mode, anchorId: mode === 'reading' ? 'it_9' : '', settled: true }];
  let mode = 'following';
  const ev = async (expr) => {
    if (expr.includes('data-view-mode')) {
      note('sample');
      return sample(mode);
    }
    note(kindOf(expr));
    return true;
  };
  const page = {
    evaluate: ev,
    send: async (_method, params) => {
      if (params.type !== 'keyDown') return;
      note(params.key);
      mode = params.key === 'End' ? 'following' : 'reading';
    },
  };
  return { calls, d: { kit: { ev, page } } };
}

const runner = { fault: async () => 'fault', answer: async () => 'answer' };

test('a scroll mid-turn is the driver’s answer: each move records its input, presses its key, then samples the view', async () => {
  const facts = { probes: { inputs: [] } };
  const { calls, d } = notingDriver(facts);
  const pause = async () => calls.push({ what: 'pause', inputs: facts.probes.inputs.length, views: facts.probes.views.length });
  const act = interruptAct({ after: 5, do: 'scroll', moves: ['up', 'end'] }, { ...runner, ctx: { d, facts, step: 6, pause } });
  assert.equal(act.do, 'answer');
  const said = await act.answer();
  assert.deepEqual(
    calls.map((c) => [c.what, c.inputs, c.views]),
    [
      ['focus', 1, 0],
      ['PageUp', 1, 0],
      ['still', 1, 0],
      ['sample', 1, 0],
      ['working', 1, 1],
      ['pause', 1, 1],
      ['focus', 2, 1],
      ['End', 2, 1],
      ['still', 2, 1],
      ['sample', 2, 1],
      ['working', 2, 2],
    ],
  );
  assert.deepEqual(
    facts.probes.inputs.map((x) => [x.step, x.kind]),
    [
      [6, 'scroll'],
      [6, 'scroll'],
    ],
  );
  assert.deepEqual(
    facts.probes.views.map((v) => [v.step, v.mode]),
    [
      [6, 'reading'],
      [6, 'following'],
    ],
  );
  assert.equal(said, 'Scrolled: PageUp (reading, at it_9, while the agent worked); End (following, while the agent worked).');
});

test('a scroll mid-turn with no moves, too many, or one it doesn’t know fails before the agent works its seconds', () => {
  for (const [moves, message] of [
    [undefined, /needs moves: 1 to 8 of up, down, end or start/],
    [[], /needs moves/],
    [Array(MOVES_MAX + 1).fill('up'), /needs moves/],
    [['up', 'sideways'], /A move is up, down, end or start, not “sideways”/],
    [['toString'], /not “toString”/],
  ]) {
    const facts = { probes: { inputs: [] } };
    const { calls, d } = notingDriver(facts);
    assert.throws(() => interruptAct({ after: 5, do: 'scroll', moves }, { ...runner, ctx: { d, facts, step: 1 } }), message);
    assert.deepEqual(calls, [], 'nothing reached the page');
  }
  assert.deepEqual(scrollMoves({ moves: Array(MOVES_MAX).fill('down') }).length, MOVES_MAX);
});

test('the tester can scroll while a turn runs, and is told a step of its own never does', () => {
  const it = SCHEMA.properties.action.properties.interrupt.properties;
  assert.ok(it.do.enum.includes('scroll'));
  assert.deepEqual(it.moves.items.enum, ['up', 'down', 'end', 'start']);
  const prompt = systemPrompt({ scenario: parseScenario('# T\n'), issues: [] });
  assert.match(prompt, /a step of its own, scroll included, never runs while a reply streams/);
  assert.match(prompt, /scroll, to make each of moves in order/);
  assert.match(prompt, /give an interrupt \{after, do: scroll, moves\}/);
});
