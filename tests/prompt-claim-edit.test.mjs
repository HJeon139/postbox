// #353 and #665 on a recorded Edit and Write: does the CLI ask with the input the stream showed? The turn is
// permission-edit.jsonl (Claude Code 2.1.318, Ask me), with the prompts its CLI sent (permission-edit-prompts.json).
// The Edit’s streamed input_json_delta never carries replace_all, but its whole assistant message and its prompt both
// do, in another key order: a prompt counts when its input deep-equals the call’s, so the Edit gets its card.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { answerNow, openCard, prompt, pushEvent, refusals, turn } from './prompt-setup.mjs';
import { cards, setup } from './requested-setup.mjs';

const fixture = (name) => new URL(`fixtures/claude-code/${name}`, import.meta.url);
const STREAM = readFileSync(fixture('permission-edit.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const PROMPTS = JSON.parse(readFileSync(fixture('permission-edit-prompts.json'), 'utf8')).prompts;
const toolUse = (id) => STREAM.flatMap((e) => (e.type === 'assistant' ? e.message.content : [])).find((b) => b.type === 'tool_use' && b.id === id);
/** The index of the line after which the CLI asked: its call’s whole assistant message is in, its result isn’t yet. */
const askedAfter = (id) => STREAM.findIndex((e) => e.type === 'assistant' && e.message.content.some((b) => b.id === id)) + 1;

test('#353 the recorded Edit and Write prompts each reach their card: the input the CLI asks with is its assistant message’s', async () => {
  const [edit] = PROMPTS;
  const shown = toolUse(edit.tool_use_id).input;
  assert.notDeepEqual(Object.keys(shown), Object.keys(edit.input), 'the recording’s key orders differ');
  assert.ok(isDeepStrictEqual(shown, edit.input), 'and its inputs are equal');
  const s = await setup();
  const answers = [];
  await turn(s, async (c) => {
    let at = 0;
    for (const p of PROMPTS) {
      const upTo = askedAfter(p.tool_use_id);
      for (const e of STREAM.slice(at, upTo)) pushEvent(c, e);
      at = upTo;
      const asked = prompt(s, p);
      const card = await openCard(s);
      assert.ok(card, `the ${p.tool_name} prompt got a card`);
      assert.deepEqual([card.tool, card.input, card.toolUseId], [p.tool_name, toolUse(p.tool_use_id).input, p.tool_use_id]);
      await s.rt.act(s.t.id, card.id, 'allow', {});
      answers.push(await answerNow(asked, `the allow on the ${p.tool_name} card`));
    }
    for (const e of STREAM.slice(at)) pushEvent(c, e);
  });
  assert.deepEqual(
    answers.map((a) => a.behavior),
    ['allow', 'allow'],
  );
  assert.deepEqual(
    cards(s).map((c) => c.tool),
    ['Edit', 'Write'],
  );
  assert.equal(refusals(s).length, 0, 'neither was refused');
});

test('#353 the recorded init doesn’t offer permission_prompt to the model among its tools', () => {
  const init = STREAM.find((e) => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.claude_code_version, '2.1.318');
  assert.ok(
    init.tools.some((t) => t.startsWith('mcp__postbox__')),
    'Postbox’s other tools are there',
  );
  assert.ok(!init.tools.includes('mcp__postbox__permission_prompt'));
});
