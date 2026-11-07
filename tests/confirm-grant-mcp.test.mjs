// #852 slice 1a, end to end through permission_prompt as the Claude Code CLI calls it: a confirmed command the stream
// showed is answered allow with no card, and a prompt for it the stream never showed is refused before the rule looks
// (WJ-2's binding, prompt-claim.mjs), so a forged prompt can't spend the person's confirm.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { cards, confirm, lines, setup, until } from './requested-setup.mjs';

const LABEL = 'gh pr edit 896 --repo o/r --add-label "ready for integrator"';
const statement = 'Confirming labels the PR.';

/** The agent shows the confirm, the person confirms it, and the next turn runs `step`. */
async function confirmedThen(s, step) {
  s.next.push(async (c) => c.tools.show_block({ block: { ...confirm(statement), commands: [LABEL] } }));
  s.rt.sendMessage(s.t.id, { text: 'Label it.' });
  await until(() => !s.rt.turns.size);
  const it = s.store.items(s.t.id).find((i) => i.kind === 'block');
  let done = false;
  s.next.push(async (c) => {
    await step(c);
    done = true;
  });
  await s.rt.act(s.t.id, it.id, 'confirm', {}, it.revision ?? 1);
  // A prompt the stream never shows waits for its call up to PROMPT_CALL_WAIT_MS (5 s) before it's refused.
  for (let i = 0; i < 40 && !(done && !s.rt.turns.size); i++) await until(() => done && !s.rt.turns.size);
}

const prompt = (s, c, args) =>
  handleMcp(
    s.rt,
    s.rt.sessionsIn(s.t.id)[0].id,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'permission_prompt', arguments: args } },
    new URL(c.mcpUrl).searchParams.get('turn'),
  );
const answerOf = (reply) => JSON.parse(reply.result.content[0].text);

test('#852 1a r3: permission_prompt for a confirmed command the stream showed: Postbox runs it, with no card', async () => {
  const s = await setup({ permissionMode: 'ask' });
  s.rt.runGh = async (argv) => ({ status: 0, output: 'ok', argv, timedOut: false });
  let reply;
  await confirmedThen(s, async (c) => {
    c.toolUse({ id: 'tu1', name: 'Bash', input: { command: LABEL, description: 'Label the PR' } });
    reply = await prompt(s, c, { tool_name: 'Bash', input: { command: LABEL, description: 'Label the PR' }, tool_use_id: 'tu1' });
  });
  const answer = answerOf(reply);
  assert.equal(answer.behavior, 'deny', 'the agent’s own call never runs');
  assert.match(answer.message, /^Postbox ran this for you, as the person confirmed/);
  assert.equal(cards(s).length, 0);
  assert.equal(lines(s).length, 1);
});

test('#852 1a: a prompt for the confirmed command that the stream never showed is refused, and spends nothing', async () => {
  const s = await setup({ permissionMode: 'ask' });
  s.rt.runGh = async (argv) => ({ status: 0, output: 'ok', argv, timedOut: false });
  let forged;
  let real;
  await confirmedThen(s, async (c) => {
    const asked = prompt(s, c, { tool_name: 'Bash', input: { command: LABEL }, tool_use_id: 'tu-forged' });
    forged = await asked;
    c.toolUse({ id: 'tu2', name: 'Bash', input: { command: LABEL } });
    real = await prompt(s, c, { tool_name: 'Bash', input: { command: LABEL }, tool_use_id: 'tu2' });
  });
  assert.equal(answerOf(forged).behavior, 'deny');
  assert.match(answerOf(real).message, /^Postbox ran this/, 'the forged prompt didn’t use the confirm up');
  assert.equal(lines(s).length, 1);
});
