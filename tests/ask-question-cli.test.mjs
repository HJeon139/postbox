// #521 on the Claude Code CLI’s own path: the turn’s stream shows the AskUserQuestion call, the CLI posts it to
// permission_prompt (server/permission-prompt.mjs), and the person’s pick comes back as the prompt’s answer, in the
// recorded shape (fixtures/claude-code/ask-user-question-prompts.json). No permission card is shown.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { answerNow, prompt, pushEvent, STREAM, turn } from './prompt-setup.mjs';
import { cards, setup, until } from './requested-setup.mjs';

const RECORDED = JSON.parse(readFileSync(new URL('fixtures/claude-code/ask-user-question-prompts.json', import.meta.url), 'utf8')).prompts;

test('#521 the CLI’s AskUserQuestion prompt is a choice block, and the pick is permission_prompt’s answer', async () => {
  const s = await setup();
  const { input, tool_use_id } = RECORDED.find((p) => p.run === 'one-auto');
  let answer;
  await turn(s, async (c) => {
    // The stream’s own line for the call, as the recorded turn’s first tool call is, with AskUserQuestion in it.
    const shown = structuredClone(STREAM.find((e) => e.type === 'assistant' && e.message.content.some((b) => b.type === 'tool_use')));
    shown.message.content = [{ type: 'tool_use', id: tool_use_id, name: 'AskUserQuestion', input }];
    pushEvent(c, shown);
    const asked = prompt(s, { tool_name: 'AskUserQuestion', input, tool_use_id });
    await until(() => s.store.items(s.t.id).some((i) => i.kind === 'block' && i.question));
    const q = s.store.items(s.t.id).find((i) => i.kind === 'block' && i.question);
    await s.rt.act(s.t.id, q.id, 'choose', { selected: [q.block.options.find((o) => o.label === 'Green').id] });
    answer = await answerNow(asked, 'the pick on the question');
  });
  assert.deepEqual(answer, { behavior: 'allow', updatedInput: { ...input, answers: { [input.questions[0].question]: 'Green' } } });
  assert.equal(cards(s).length, 0, 'no permission card');
});
