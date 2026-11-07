// #353 and #665: what a refused permission prompt says (server/prompt-claim.mjs). The agent’s answer reads true
// whoever sent the prompt, the CLI or a command the agent ran; the person sees a line for each call a prompt named,
// naming the stream’s call when it named one, up to PROMPT_REFUSAL_LINES a turn and then one line that counts the
// rest. Beside tests/prompt-claim.test.mjs, which holds the claim itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFUSED } from '../server/prompt-claim.mjs';
import { PROMPT_CALL_WAIT_MS, PROMPT_REFUSAL_LINES } from '../shared/limits.mjs';
import { answerNow, askedAfter, feed, flush, openCard, PROMPTS, prompt, refusals, settled, turn } from './prompt-setup.mjs';
import { cards, setup } from './requested-setup.mjs';

/** Prompts for ids no stream showed, each refused at the bound. */
async function unseen(s, t, ids) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const asked = Promise.all(ids.map((id) => prompt(s, { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: id })));
    await flush();
    t.mock.timers.tick(PROMPT_CALL_WAIT_MS);
    return await answerNow(asked, 'the refusals at the bound');
  } finally {
    t.mock.timers.reset();
  }
}

test('#353 a refused prompt’s answer doesn’t say the agent sent it: it reads true from the CLI too', () => {
  assert.equal(
    REFUSED.unseen,
    'Postbox didn’t ask the person: it saw no call of this turn with that tool_use_id waiting to run, so the call was denied. If you need it, make the call again.',
  );
  assert.equal(
    REFUSED.differs,
    'Postbox didn’t ask the person: this prompt’s tool_name or input isn’t that of the call with that tool_use_id, so the call was denied. If you need it, make the call again.',
  );
});

test('#353 each refused call gets its own line, the stream’s call named when the prompt named one, a repeat none', async (t) => {
  const s = await setup();
  const [p] = PROMPTS;
  await turn(s, async (c) => {
    feed(c, 0, askedAfter(p.tool_use_id));
    // The CLI’s own prompt for its call, with an input that isn’t the stream’s (a hook rewrote it, say), twice.
    for (let i = 0; i < 2; i++) await prompt(s, { ...p, input: { ...p.input, command: 'echo hi >> note.txt' } });
    // Then one for a call no stream showed, twice: the first line doesn’t hide it.
    await unseen(s, t, ['toolu_01NotAnyCallOfThisTurn', 'toolu_01NotAnyCallOfThisTurn']);
    // The real prompt asks; a copy after it is a second answer for a call already named, and says so too.
    const real = prompt(s, p);
    const card = await openCard(s);
    await prompt(s, p);
    await s.rt.act(s.t.id, card.id, 'deny', {});
    await real;
    feed(c, askedAfter(p.tool_use_id));
  });
  assert.deepEqual(
    refusals(s).map((i) => i.text),
    [
      'Refused a permission prompt from @now: it differed from the call it named (run a command: Write hi to note.txt) in its input at "command", so nobody was asked. If @now needs that call, ask it to make it again.',
      'Refused a permission prompt from @now: it named no call of this turn waiting to run, so nobody was asked. If @now needs that call, ask it to make it again.',
      '@now’s call was asked about already, so a second answer for this call was refused: run a command: Write hi to note.txt',
    ],
  );
});

test('#353 two calls each asked about twice show a line each', async () => {
  const s = await setup();
  const answers = [];
  await turn(s, async (c) => {
    let at = 0;
    for (const p of PROMPTS) {
      const upTo = askedAfter(p.tool_use_id);
      feed(c, at, upTo);
      at = upTo;
      const asked = prompt(s, p);
      const card = await openCard(s);
      answers.push(await prompt(s, p));
      await s.rt.act(s.t.id, card.id, 'allow', {});
      await answerNow(asked, 'the allow on the card');
    }
    feed(c, at);
  });
  assert.deepEqual(
    answers.map((a) => a.message),
    [REFUSED.again, REFUSED.again],
  );
  assert.deepEqual(
    refusals(s).map((i) => i.text),
    [
      '@now’s call was asked about already, so a second answer for this call was refused: run a command: Write hi to note.txt',
      '@now’s call was asked about already, so a second answer for this call was refused: run a command: Write bye to note2.txt',
    ],
  );
});

test('#665 a flood of refused prompts shows a few lines, then one that counts the rest', async (t) => {
  const s = await setup();
  const ids = Array.from({ length: PROMPT_REFUSAL_LINES + 1 }, (_, i) => `toolu_01Forged${i}`);
  const texts = [];
  await turn(s, async (c) => {
    await unseen(s, t, ids);
    texts.push(refusals(s).at(-1).text);
    // Three more new ids, and one already shown, which adds nothing.
    await unseen(s, t, ['toolu_01ForgedA', 'toolu_01ForgedB', 'toolu_01ForgedC', ids[0]]);
    // The CLI’s own prompt still asks.
    feed(c, 0, askedAfter(PROMPTS[0].tool_use_id));
    await settled(s, prompt(s, PROMPTS[0]));
    feed(c, askedAfter(PROMPTS[0].tool_use_id));
  });
  assert.equal(texts[0], '1 more permission prompt from @now was refused this turn, so nobody was asked.');
  const lines = refusals(s).map((i) => i.text);
  assert.equal(lines.length, PROMPT_REFUSAL_LINES + 1, 'the cap, and one line that counts');
  assert.equal(lines.at(-1), '4 more permission prompts from @now were refused this turn, so nobody was asked.');
  assert.equal(cards(s).length, 1, 'the real prompt’s card');
});

/** The line for a prompt that differs from the call it named, the recorded Bash call’s, in `what`. */
const differs = (what) =>
  `Refused a permission prompt from @now: it differed from the call it named (run a command: Write hi to note.txt) in ${what}, so nobody was asked. If @now needs that call, ask it to make it again.`;

test('#353 a prompt that differs from its call says which part did: the tool’s name, or the input’s keys, never their values', async () => {
  const s = await setup();
  const [p] = PROMPTS;
  const answers = [];
  await turn(s, async (c) => {
    feed(c, 0, askedAfter(p.tool_use_id));
    // Four more calls with the recorded one’s input, so each prompt below names a call of its own.
    for (const id of ['tu-key', 'tu-both', 'tu-whole', 'tu-missing']) c.toolUse({ id, name: p.tool_name, input: p.input });
    answers.push(await prompt(s, { ...p, tool_name: 'bash' }));
    answers.push(await prompt(s, { ...p, tool_use_id: 'tu-key', input: { ...p.input, command: 'echo SECRET-VALUE >> note.txt' } }));
    answers.push(await prompt(s, { ...p, tool_use_id: 'tu-both', tool_name: 'bash', input: { ...p.input, dangerouslyDisableSandbox: true } }));
    answers.push(await prompt(s, { ...p, tool_use_id: 'tu-whole', input: JSON.stringify(p.input) }));
    answers.push(await prompt(s, { tool_name: p.tool_name, tool_use_id: 'tu-missing' }));
    feed(c, askedAfter(p.tool_use_id));
  });
  assert.ok(answers.every((a) => a.message === REFUSED.differs));
  assert.deepEqual(
    refusals(s).map((i) => i.text),
    [
      differs('its tool name'),
      differs('its input at "command"'),
      differs('its tool name and in its input at "dangerouslyDisableSandbox"'),
      differs('its whole input'),
      differs('its input at "command" and "description"'),
    ],
  );
  assert.ok(
    refusals(s).every((i) => !i.text.includes('SECRET-VALUE')),
    'no value reaches the line',
  );
});

test('#353 the keys a differing prompt’s line names are escaped and clipped, and only a few are named', async () => {
  const s = await setup();
  const [p] = PROMPTS;
  const long = 'k'.repeat(10_000);
  await turn(s, async (c) => {
    feed(c, 0, askedAfter(p.tool_use_id));
    for (const id of ['tu-many', 'tu-six']) c.toolUse({ id, name: p.tool_name, input: p.input });
    // Keys are the agent’s text: a quote, markup, an entity, a NUL and a very long one, with values of their own.
    const hostile = { '"q': 'SECRET-VALUE', '<b>': 1, '&amp;': 2, 'a\u0000b': 3, [long]: 4 };
    await prompt(s, { ...p, input: { ...p.input, ...hostile } });
    const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i + 1}`, i]));
    await prompt(s, { ...p, tool_use_id: 'tu-many', input: { ...p.input, ...keys(7) } });
    await prompt(s, { ...p, tool_use_id: 'tu-six', input: { ...p.input, ...keys(6) } });
    feed(c, askedAfter(p.tool_use_id));
  });
  const lines = refusals(s).map((i) => i.text);
  assert.deepEqual(lines, [
    differs(`its input at "\\"q", "\\u003cb\\u003e", "\\u0026amp;", "a\\u0000b" and "${'k'.repeat(40)}…"`),
    differs('its input at "k1", "k2", "k3", "k4", "k5" and 2 more keys'),
    differs('its input at "k1", "k2", "k3", "k4", "k5" and 1 more key'),
  ]);
  assert.ok(
    lines.every((l) => !['<', '&', '\u0000', 'SECRET-VALUE'].some((said) => l.includes(said)) && l.length < 400),
    'no markup, NUL, value or long key reaches the line',
  );
});
