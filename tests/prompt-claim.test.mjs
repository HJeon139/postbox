// #353 and #665: a permission prompt counts only when it’s for a call the turn’s stream showed, still waiting for its
// result, with that call’s tool and input, once (server/prompt-claim.mjs). The turn’s token is in the CLI’s arguments,
// so a command the agent runs can post a prompt of its own to /mcp: that one is refused before the write judge, its
// budget or a card. The recorded turn is permission-subagent.jsonl, with the prompts its CLI sent
// (permission-prompts.json).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimPrompt, REFUSED } from '../server/prompt-claim.mjs';
import { REQUESTED_MAX } from '../server/write-intent.mjs';
import { PROMPT_CALL_WAIT_MS } from '../shared/limits.mjs';
import { answerNow, askedAfter, feed, flush, openCard, PROMPTS, prompt, pushEvent, refusals, STREAM, settled, turn } from './prompt-setup.mjs';
import { CREATE, cards, lines, setup } from './requested-setup.mjs';

test('#353 the recorded turn’s two prompts, its own call’s and its subagent’s, each reach their card, drawn from the stream', async () => {
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
      assert.deepEqual([card.tool, card.input, card.toolUseId], [p.tool_name, p.input, p.tool_use_id]);
      await s.rt.act(s.t.id, card.id, 'allow', {});
      answers.push(await answerNow(asked, 'the allow on the card'));
    }
    feed(c, at);
  });
  assert.deepEqual(
    answers.map((a) => a.behavior),
    ['allow', 'allow'],
  );
  assert.deepEqual(
    cards(s).map((c) => c.who ?? null),
    [null, 'general-purpose'],
    'the subagent’s is named by its call',
  );
  assert.equal(refusals(s).length, 0);
});

test('#353 whether a subagent made the call is the stream’s word, not the prompt’s agent_id', async () => {
  const s = await setup();
  const claims = [];
  const sub = STREAM[askedAfter(PROMPTS[1].tool_use_id) - 1].parent_tool_use_id;
  await turn(s, async (c) => {
    const se = s.rt.sessionsIn(s.t.id)[0];
    feed(c, 0, askedAfter(PROMPTS[0].tool_use_id));
    claims.push(await claimPrompt(s.rt, se.id, { ...PROMPTS[0], agent_id: 'task-not-a-subagent' }));
    feed(c, askedAfter(PROMPTS[0].tool_use_id), askedAfter(PROMPTS[1].tool_use_id));
    claims.push(await claimPrompt(s.rt, se.id, PROMPTS[1]));
    feed(c, askedAfter(PROMPTS[1].tool_use_id));
  });
  assert.ok(sub, 'the recorded subagent’s call is under its Agent call');
  assert.deepEqual(
    claims.map((x) => x.agentId),
    [null, sub],
  );
});

test('#353 a prompt that comes before its call’s line waits for it, and the line, not the clock, lets it through', async (t) => {
  const s = await setup();
  const [p] = PROMPTS;
  let answer = null;
  await turn(s, async (c) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const asked = prompt(s, p).then((a) => {
        answer = a;
      });
      await flush();
      assert.equal(cards(s).length, 0, 'no card before the stream shows the call');
      // The stream is late: its line comes now, and the clock never moved.
      feed(c, 0, askedAfter(p.tool_use_id));
      await flush();
      const card = cards(s).find((x) => x.status === 'open');
      assert.ok(card, 'the line let the prompt through');
      await s.rt.act(s.t.id, card.id, 'allow', {});
      await answerNow(asked, 'the allow on the card');
    } finally {
      t.mock.timers.reset();
    }
    feed(c, askedAfter(p.tool_use_id));
  });
  assert.equal(answer.behavior, 'allow');
});

test('#353 a prompt for a call the stream never showed waits its bound, then is refused: no card, no judge, one line', async (t) => {
  const s = await setup();
  /** @type {any} */
  let answer = null;
  await turn(
    s,
    async () => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const asked = prompt(s, { tool_name: 'Bash', input: CREATE.input, tool_use_id: 'toolu_01NotAnyCallOfThisTurn' }).then((a) => {
          answer = a;
        });
        await flush();
        t.mock.timers.tick(PROMPT_CALL_WAIT_MS - 1);
        await flush();
        assert.equal(answer, null, 'it’s still waiting for the stream, a moment short of the bound');
        t.mock.timers.tick(1);
        await answerNow(asked, 'the refusal at the bound');
      } finally {
        t.mock.timers.reset();
      }
    },
    'Push it and open the PR.',
  );
  assert.deepEqual(answer, { behavior: 'deny', message: REFUSED.unseen });
  assert.equal(cards(s).length, 0, 'no card');
  assert.equal(s.prompts.length, 0, 'the judge wasn’t asked');
  assert.equal(lines(s).length, 0, 'nothing ran on the person’s request');
  assert.deepEqual(
    refusals(s).map((i) => i.text),
    [
      'Refused a permission prompt from @now: it named no call of this turn waiting to run, so nobody was asked. If @now needs that call, ask it to make it again.',
    ],
  );
});

test('#665 prompts for calls the agent never made use none of the write budget', async () => {
  const s = await setup();
  const asks = [];
  await turn(
    s,
    async (c) => {
      // The agent’s own command is a call the stream showed; the prompts it posts name it, with the PR’s command.
      c.toolUse({ id: 'tu-curl', name: 'Bash', input: { command: 'curl -s 127.0.0.1/mcp' } });
      for (let i = 0; i <= REQUESTED_MAX; i++) {
        asks.push(await settled(s, prompt(s, { tool_name: 'Bash', input: CREATE.input, tool_use_id: 'tu-curl' })));
      }
      // Then the CLI’s own prompt for a real call, which the person’s words ask for.
      c.toolUse({ id: 'tu-pr', name: 'Bash', input: CREATE.input });
      asks.push(await settled(s, prompt(s, { tool_name: 'Bash', input: CREATE.input, tool_use_id: 'tu-pr' })));
    },
    'Push it and open the PR.',
  );
  assert.deepEqual(
    asks.slice(0, -1).map((a) => a.message),
    Array(REQUESTED_MAX + 1).fill(REFUSED.differs),
  );
  assert.equal(asks.at(-1).behavior, 'allow', 'the real call still runs on the person’s request');
  assert.equal(s.prompts.length, 1, 'the judge read only the real call');
  assert.equal(lines(s).length, 1);
  assert.equal(cards(s).length, 0);
  assert.deepEqual(
    refusals(s).map((i) => i.text),
    [
      'Refused a permission prompt from @now: it differed from the call it named (run a command) in its input at "command", so nobody was asked. If @now needs that call, ask it to make it again.',
    ],
    'one line for the call they all named, however many it sends',
  );
});

test('#353 a second prompt for a call already asked about is refused, with a line the person sees; the card shows the stream’s input', async () => {
  const s = await setup();
  const [p] = PROMPTS;
  const answers = [];
  await turn(s, async (c) => {
    feed(c, 0, askedAfter(p.tool_use_id));
    // A copy of the real prompt comes first, its input in another key order.
    const copy = prompt(s, { ...p, input: { description: p.input.description, command: p.input.command } });
    const card = await openCard(s);
    assert.deepEqual(Object.keys(card.input), Object.keys(p.input), 'the card draws the stream’s input');
    answers.push(await prompt(s, p));
    await s.rt.act(s.t.id, card.id, 'deny', {});
    answers.push(await copy);
    feed(c, askedAfter(p.tool_use_id));
  });
  assert.deepEqual(answers[0], { behavior: 'deny', message: REFUSED.again });
  assert.equal(answers[1].behavior, 'deny');
  assert.equal(cards(s).length, 1, 'one card for one call');
  assert.deepEqual(
    refusals(s).map((i) => i.text),
    ['@now’s call was asked about already, so a second answer for this call was refused: run a command: Write hi to note.txt'],
  );
});

test('#353 of two prompts waiting for one call, the first to arrive claims it when its line comes; the second is refused', async (t) => {
  const s = await setup();
  const [p] = PROMPTS;
  const answers = [];
  await turn(s, async (c) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // Both come before the call’s line: the first is the CLI’s, the second a copy that came a moment later.
      const first = prompt(s, p).then((a) => answers.push(['first', a]));
      await flush();
      const second = prompt(s, p).then((a) => answers.push(['second', a]));
      await flush();
      feed(c, 0, askedAfter(p.tool_use_id));
      await answerNow(second, 'the second prompt’s refusal, once the line came');
      assert.deepEqual(answers, [['second', { behavior: 'deny', message: REFUSED.again }]], 'the second is refused, the first still asks');
      const card = cards(s).find((x) => x.status === 'open');
      await s.rt.act(s.t.id, card.id, 'allow', {});
      await answerNow(first, 'the allow on the first prompt’s card');
    } finally {
      t.mock.timers.reset();
    }
    feed(c, askedAfter(p.tool_use_id));
  });
  assert.equal(answers[1][0], 'first');
  assert.equal(answers[1][1].behavior, 'allow', 'the first to arrive got the card');
  assert.equal(cards(s).length, 1);
});

test('#353 a call whose whole input is empty is known from its message, so the prompt for it can match', async (t) => {
  // No recorded turn has one yet (a tool that takes no arguments): these are the recorded calls’ whole messages, the
  // agent’s own and its subagent’s, with their input emptied, as a turn without partial messages sends them.
  const s = await setup();
  const emptied = PROMPTS.map((p) => {
    const line = structuredClone(STREAM[askedAfter(p.tool_use_id) - 1]);
    line.message.content[0].input = {};
    return line;
  });
  const shown = [];
  await turn(s, async (c) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      for (const [i, p] of PROMPTS.entries()) {
        pushEvent(c, emptied[i]);
        const asked = prompt(s, { ...p, input: {} });
        await flush();
        const card = cards(s).find((x) => x.status === 'open');
        shown.push(card?.input ?? null);
        t.mock.timers.tick(PROMPT_CALL_WAIT_MS);
        if (card) await s.rt.act(s.t.id, card.id, 'allow', {});
        await answerNow(asked, 'the answer, on the card or at the bound');
      }
    } finally {
      t.mock.timers.reset();
    }
  });
  assert.deepEqual(shown, [{}, {}], 'each prompt reached its card without waiting for the call’s result');
});
