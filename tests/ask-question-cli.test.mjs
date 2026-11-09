// #521 on the Claude Code CLI’s own path: the turn’s stream shows the AskUserQuestion call, the CLI posts it to
// permission_prompt (server/permission-prompt.mjs), and the person’s pick comes back as the prompt’s answer, in the
// recorded shape (fixtures/claude-code/ask-user-question-prompts.json). No permission card is shown.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { answerNow, prompt, pushEvent, STREAM, turn } from './prompt-setup.mjs';
import { cards, setup, until } from './requested-setup.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('fixtures/claude-code/ask-user-question-prompts.json', import.meta.url), 'utf8'));
const RECORDED = FIXTURE.prompts;
/** The stream’s line for the call, as the recorded turn’s first tool call is, with AskUserQuestion in it. */
function callLine(tool_use_id, input) {
  const shown = structuredClone(STREAM.find((e) => e.type === 'assistant' && e.message.content.some((b) => b.type === 'tool_use')));
  shown.message.content = [{ type: 'tool_use', id: tool_use_id, name: 'AskUserQuestion', input }];
  return shown;
}
const questionOf = (s) => s.store.items(s.t.id).find((i) => i.kind === 'block' && i.question);

test('#521 the CLI’s AskUserQuestion prompt is a choice block, and the pick is permission_prompt’s answer', async () => {
  const s = await setup();
  const { input, tool_use_id } = RECORDED.find((p) => p.run === 'one-auto');
  let answer;
  await turn(s, async (c) => {
    pushEvent(c, callLine(tool_use_id, input));
    const asked = prompt(s, { tool_name: 'AskUserQuestion', input, tool_use_id });
    await until(() => questionOf(s));
    const q = questionOf(s);
    await s.rt.act(s.t.id, q.id, 'choose', { selected: [q.block.options.find((o) => o.label === 'Green').id] });
    answer = await answerNow(asked, 'the pick on the question');
  });
  assert.deepEqual(answer, { behavior: 'allow', updatedInput: { ...input, answers: { [input.questions[0].question]: 'Green' } } });
  assert.equal(cards(s).length, 0, 'no permission card');
});

test('#521 a dismissed question raises no refusal card, though the CLI lists it in permission_denials', async () => {
  const s = await setup();
  const { input, tool_use_id } = RECORDED.find((p) => p.run === 'deny-auto');
  let answer;
  await turn(s, async (c) => {
    pushEvent(c, callLine(tool_use_id, input));
    const asked = prompt(s, { tool_name: 'AskUserQuestion', input, tool_use_id });
    await until(() => questionOf(s));
    await s.rt.act(s.t.id, questionOf(s).id, 'dismiss', {});
    answer = await answerNow(asked, 'the dismissal');
    pushEvent(c, FIXTURE.deniedResult.line);
  });
  assert.equal(answer.behavior, 'deny');
  assert.equal(s.store.items(s.t.id).filter((i) => i.kind === 'denial').length, 0, 'no “a step was refused” card');
});

test('#521 when the CLI’s prompt closes, the question’s call ends, and a later answer reaches the agent as an event', async () => {
  const s = await setup();
  const { input, tool_use_id } = RECORDED.find((p) => p.run === 'one-auto');
  const closed = new AbortController();
  let answer;
  await turn(s, async (c) => {
    pushEvent(c, callLine(tool_use_id, input));
    const asked = prompt(s, { tool_name: 'AskUserQuestion', input, tool_use_id }, closed.signal);
    await until(() => questionOf(s));
    closed.abort();
    answer = await answerNow(asked, 'the closed prompt');
  });
  assert.equal(answer.behavior, 'deny');
  const q = questionOf(s);
  assert.equal(s.store.item(s.t.id, q.id).answered, false, 'the block stays asking');
  // No call holds it any more, so the answer goes as an event, which starts the agent’s next turn.
  let heard = false;
  s.next.push(async (c) => {
    heard = true;
    c.text('ok');
  });
  await s.rt.act(s.t.id, q.id, 'choose', { selected: [q.block.options[0].id] });
  await until(() => heard);
});
