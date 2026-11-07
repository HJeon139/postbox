// #353 and #665: how many permission prompts a turn holds open while each waits for its call’s line
// (server/prompt-claim.mjs, PROMPT_HOLDS_MAX). Each held prompt is an open request, so a flood from a command the agent
// runs holds only a few, and the rest are refused at once; the CLI’s own prompt still asks. Beside
// tests/prompt-claim.test.mjs, which holds the claim itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFUSED } from '../server/prompt-claim.mjs';
import { PROMPT_CALL_WAIT_MS, PROMPT_HOLDS_MAX, PROMPT_REFUSAL_LINES } from '../shared/limits.mjs';
import { answerNow, askedAfter, feed, flush, PROMPTS, prompt, refusals, turn } from './prompt-setup.mjs';
import { cards, setup, until } from './requested-setup.mjs';

/** The prompts waiting for a call’s line in the session’s running turn, by its watchers. */
const waiting = (s) => {
  const watchers = s.rt.turns.get(s.rt.sessionsIn(s.t.id)[0].id)?.callWatchers ?? new Map();
  return [...watchers.values()].reduce((n, set) => n + set.size, 0);
};
/** A prompt for an id no stream showed, and whether it was answered yet. */
function forged(s, id) {
  const p = { answer: null };
  p.asked = prompt(s, { tool_name: 'Bash', input: { command: 'gh pr create' }, tool_use_id: id }).then((a) => {
    p.answer = a;
  });
  return p;
}

test('#665 a flood of prompts for unseen ids holds only PROMPT_HOLDS_MAX open; the rest are refused at once, and the real one asks', async (t) => {
  const s = await setup();
  const [p] = PROMPTS;
  const held = [];
  let real = null;
  await turn(s, async (c) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const flood = Array.from({ length: 50 }, (_, i) => forged(s, `toolu_01Flood${i}`));
      await flush();
      held.push(waiting(s));
      held.push(flood.filter((f) => !f.answer).length);
      assert.ok(
        flood.filter((f) => f.answer).every((f) => f.answer.message === REFUSED.unseen),
        'the rest are refused as unseen',
      );
      // The CLI’s call shows in the stream, and its own prompt still gets its card.
      feed(c, 0, askedAfter(p.tool_use_id));
      const asked = prompt(s, p);
      await flush();
      const card = cards(s).find((x) => x.status === 'open');
      assert.ok(card, 'the real prompt’s card');
      await s.rt.act(s.t.id, card.id, 'allow', {});
      real = await answerNow(asked, 'the allow on the real prompt’s card');
      t.mock.timers.tick(PROMPT_CALL_WAIT_MS);
      await answerNow(Promise.all(flood.map((f) => f.asked)), 'the held prompts’ refusal at the bound');
      assert.ok(
        flood.every((f) => f.answer.message === REFUSED.unseen),
        'the held ones at their bound',
      );
    } finally {
      t.mock.timers.reset();
    }
    feed(c, askedAfter(p.tool_use_id));
  });
  assert.deepEqual(held, [PROMPT_HOLDS_MAX, PROMPT_HOLDS_MAX], 'as many wait as the cap, no more');
  assert.equal(real.behavior, 'allow');
  assert.equal(cards(s).length, 1);
  const lines = refusals(s).map((i) => i.text);
  assert.equal(lines.length, PROMPT_REFUSAL_LINES + 1, 'no line beyond the per-call lines and the count');
  assert.equal(lines.at(-1), `${50 - PROMPT_REFUSAL_LINES} more permission prompts from @now were refused this turn, so nobody was asked.`);
});

test('#665 the cap is a turn’s: prompts an ended turn still holds don’t refuse the next turn’s', async (t) => {
  const s = await setup();
  const [p] = PROMPTS;
  const se = s.rt.sessionsIn(s.t.id)[0];
  /** One turn whose end the test decides. */
  const begin = () => {
    const at = {};
    at.ended = new Promise((r) => {
      at.end = r;
    });
    s.next.push((c) => {
      at.c = c;
      return at.ended;
    });
    s.rt.sendMessage(s.t.id, { text: 'Write the notes.' });
    return at;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flood = [];
  let answer = null;
  try {
    const first = begin();
    await flush();
    flood = Array.from({ length: PROMPT_HOLDS_MAX }, (_, i) => forged(s, `toolu_01Held${i}`));
    await flush();
    assert.equal(waiting(s), PROMPT_HOLDS_MAX, 'the first turn holds the cap');
    s.rt.stop(se.id);
    first.end();
    await flush();
    const second = begin();
    await flush();
    // The next turn’s CLI asks before its call’s line: it waits for it, not refused at once.
    const asked = prompt(s, p).then((a) => {
      answer = a;
    });
    await flush();
    assert.equal(answer, null, 'the next turn’s prompt waits');
    feed(second.c, 0, askedAfter(p.tool_use_id));
    await flush();
    const card = cards(s).find((x) => x.status === 'open');
    assert.ok(card, 'the line let it through');
    await s.rt.act(s.t.id, card.id, 'allow', {});
    await answerNow(asked, 'the allow on the card');
    t.mock.timers.tick(PROMPT_CALL_WAIT_MS);
    await answerNow(Promise.all(flood.map((f) => f.asked)), 'the ended turn’s prompts’ refusal at the bound');
    feed(second.c, askedAfter(p.tool_use_id));
    second.c.text('Done.');
    second.end();
  } finally {
    t.mock.timers.reset();
  }
  await until(() => !s.rt.turns.size);
  assert.equal(answer.behavior, 'allow');
  assert.ok(
    flood.every((f) => f.answer.message === REFUSED.ended),
    'the ended turn’s held prompts are refused as ended',
  );
});
