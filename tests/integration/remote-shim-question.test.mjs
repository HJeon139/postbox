// #1059: on a host, an AskUserQuestion that nobody answers by permissionWaitMax stays open in the conversation, as a
// choice block, so its call must hear what this computer’s says (shared/question-words.mjs), never “ask again”: asking
// again would show the question twice. The request is the recorded one-question prompt
// (fixtures/claude-code/ask-user-question-prompts.json, Claude Code 2.1.319, #521).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { STILL_OPEN } from '../../shared/question-words.mjs';
import { REQUEST, setup, textOf } from './remote-shim-fixtures.mjs';

const ONE = JSON.parse(readFileSync(new URL('../fixtures/claude-code/ask-user-question-prompts.json', import.meta.url), 'utf8')).prompts.find(
  (/** @type {any} */ p) => p.run === 'one-auto',
);

test('#1059 a host question nobody answers by permissionWaitMax hears it stays open, not to ask again', async (t) => {
  const { shim, daemon } = await setup(t, { timings: { waitMax: 150 } });
  const id = shim.tool('permission_prompt', { tool_name: 'AskUserQuestion', input: ONE.input, tool_use_id: ONE.tool_use_id });
  await daemon.next('permission');
  const decision = JSON.parse(textOf(await shim.response(id)));
  assert.equal(decision.behavior, 'deny');
  assert.ok(decision.message.includes(STILL_OPEN), decision.message);
  assert.doesNotMatch(decision.message, /Ask again/);
  await daemon.next('permission-expired');
});

test('#1059 any other prompt still hears it was denied and may be asked again', async (t) => {
  const { shim, daemon } = await setup(t, { timings: { waitMax: 150 } });
  const id = shim.tool('permission_prompt', REQUEST);
  await daemon.next('permission');
  const decision = JSON.parse(textOf(await shim.response(id)));
  assert.match(decision.message, /so it was denied\. Ask again if you still need it\./);
  await daemon.next('permission-expired');
});
