// What counts as a turn’s work among Postbox’s own tools (server/tool-gate.mjs), and how a harness’s call to one is
// marked on its step (server/harness-tools.mjs), so reply-back.mjs reads one definition (#1591).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessEvents } from '../server/harness-events.mjs';
import { endedExchange } from '../server/reply-back.mjs';
import { isOwnWork, NO_ANSWER, postboxTool, READ_TOOLS } from '../server/tool-gate.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';

test('a tool that reads, reacts, asks or keeps something for later is no work of the turn’s own, and any other is', () => {
  for (const name of [...READ_TOOLS, ...NO_ANSWER, 'react']) assert.equal(isOwnWork(name), false, name);
  for (const name of ['show_block', 'update_block', 'show_app', 'update_app', 'open_topic', 'propose_agent']) assert.equal(isOwnWork(name), true, name);
  // Every name in the lists is a tool Postbox has, so a renamed tool can’t leave the lists behind.
  const known = new Set(TOOL_DEFS.map((t) => t.name));
  for (const name of [...NO_ANSWER, 'react']) assert.ok(known.has(name) || name === 'permission_prompt', name);
});

test('a harness’s call is one of Postbox’s tools by its server’s name, in every harness’s spelling of it', () => {
  assert.equal(postboxTool('mcp__postbox__list_assets'), 'list_assets');
  assert.equal(postboxTool('Bash'), null);
  assert.equal(postboxTool('mcp__other__react'), null);
  assert.equal(postboxTool(null), null);
});

/** The steps a harness’s calls made, as the turn’s context is given them. @param {string[]} names */
function stepsOf(names) {
  /** @type {any[]} */
  const activity = [];
  const { event } = new HarnessEvents({ activity: (/** @type {any} */ a) => activity.push(a), status: () => {}, text: () => {} }, { now: () => 0 });
  names.forEach((name, i) => void event({ kind: 'tool_call', id: `t${i}`, name, input: {}, final: true }));
  return activity;
}

test('#1591: a call to one of Postbox’s tools that shows as a step says so, and a harness’s own tool doesn’t', () => {
  const steps = stepsOf(['mcp__postbox__list_assets', 'mcp__postbox__search_conversation', 'mcp__postbox__view_app', 'Bash']);
  assert.deepEqual(
    steps.map((s) => [s.id, s.postbox === true]),
    [
      ['t0', true],
      ['t1', true],
      ['t2', true],
      ['t3', false],
    ],
  );
});

test('#1591: a step of one of Postbox’s tools is work only if the tool acted, so listing assets is none', () => {
  const back = { source: 'mention', from: 'alpha', bounce: true };
  const turn = (/** @type {any} */ more) => ({ asked: { message: { entries: [back] } }, steps: [{ id: 't0', label: 'list assets (postbox)' }], ...more });
  assert.equal(endedExchange(turn({ postboxSteps: new Set(['t0']) })), true, 'a read that shows as a step');
  assert.equal(endedExchange(turn({})), false, 'a harness’s own tool, such as a command');
  assert.equal(endedExchange(turn({ postboxSteps: new Set(['t0']), acted: true })), false, 'a tool of Postbox’s that acted');
});
