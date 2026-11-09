// #521: Claude Code’s AskUserQuestion reaches Postbox as a permission prompt (the CLI’s permission_prompt, the SDK’s
// canUseTool, a host’s prompt), and every one goes through requestPermission. Postbox shows each question as its own
// choice block, one at a time, and the person’s answers are the tool’s result: updatedInput { questions, answers },
// keyed by each question’s text, several labels joined with “, ”, as the recorded turns show
// (fixtures/claude-code/ask-user-question-prompts.json).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { canUseTool } from '../server/adapters/sdk-permission.mjs';
import { STILL_OPEN } from '../server/ask-question.mjs';
import { CARD_WAIT_MS } from '../server/permission-cards.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const RECORDED = JSON.parse(readFileSync(new URL('fixtures/claude-code/ask-user-question-prompts.json', import.meta.url), 'utf8')).prompts;
const inputOf = (run) => structuredClone(RECORDED.find((p) => p.run === run).input);

const until = async (fn, what) => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`Timed out waiting for ${what}`);
};

function setup() {
  const store = new Store(null);
  const delivered = [];
  const adapter = {
    name: 'scripted',
    capabilities: { promptTool: false },
    next: [],
    async deliver(_session, message, ctx) {
      delivered.push(message);
      await (this.next.shift() ?? (async (c) => c.text('ok')))(ctx);
    },
  };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'developer', backend: 'scripted', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = () => rt.sessionsIn(t.id)[0];
  const items = () => store.items(t.id);
  const questions = () => items().filter((i) => i.kind === 'block' && i.question);
  /** Starts a turn that asks with AskUserQuestion through the SDK’s canUseTool, and returns its answer. */
  function ask(input) {
    let answer;
    const asked = new Promise((r) => {
      answer = r;
    });
    adapter.next.push(async (c) => {
      answer(await canUseTool(c, 'AskUserQuestion', input, { toolUseID: 'toolu_ask_1' }));
      c.text('Done.');
    });
    rt.sendMessage(t.id, { text: 'Ask me.' });
    return asked;
  }
  /** The person picks options of the question block by label, and maybe types Other. */
  const choose = (it, labels, other) =>
    rt.act(t.id, it.id, 'choose', { selected: it.block.options.filter((o) => labels.includes(o.label)).map((o) => o.id), ...(other ? { other } : {}) });
  return { rt, store, t, se, items, questions, ask, choose, delivered, adapter };
}

test('#521 one AskUserQuestion question is a choice block, not a permission card, and the choice is the tool’s answer', async () => {
  const s = setup();
  const input = inputOf('one-auto');
  const asked = s.ask(input);
  await until(() => s.questions().length === 1, 'the question block');
  assert.equal(s.items().filter((i) => i.kind === 'permission').length, 0, 'no permission card');
  const [q] = s.questions();
  assert.equal(q.block.type, 'choice');
  assert.equal(q.block.prompt, input.questions[0].question);
  assert.deepEqual(
    q.block.options.map((o) => o.label),
    input.questions[0].options.map((o) => o.label),
  );
  assert.equal(q.block.multiple, false);
  assert.ok(q.block.other, 'an Other field for free text');
  s.choose(q, ['Blue']);
  const answer = await asked;
  assert.deepEqual(answer, { behavior: 'allow', updatedInput: { ...input, answers: { [input.questions[0].question]: 'Blue' } } });
  await until(() => !s.rt.turns.size, 'the turn to end');
  assert.equal(s.delivered.filter((m) => m.kind === 'event').length, 0, 'the answer went back as the tool’s result, not as an event');
});

test('#521 two questions show one block at a time, and a multi-select answer is its labels joined with “, ”', async () => {
  const s = setup();
  const input = inputOf('two-auto');
  const asked = s.ask(input);
  await until(() => s.questions().length === 1, 'the first question');
  assert.equal(s.questions()[0].block.prompt, 'Which color?');
  const first = s.questions()[0];
  s.choose(first, ['Green']);
  assert.notEqual(s.se().needs?.itemId, first.id, 'answered, the first no longer needs the person');
  assert.equal(s.store.item(s.t.id, first.id).answer.read, true, 'the agent has its answer, in the call’s result');
  await until(() => s.questions().length === 2, 'the second question, after the first is answered');
  const fruits = s.questions()[1];
  assert.equal(fruits.block.prompt, 'Which fruits?');
  assert.equal(fruits.block.multiple, true);
  s.choose(fruits, ['Plum', 'Apple']);
  const answer = await asked;
  assert.deepEqual(answer.updatedInput.answers, { 'Which color?': 'Green', 'Which fruits?': 'Apple, Plum' });
});

test('#521 the Other text is the answer, and dismissing denies the call and shows no later question', async () => {
  const s = setup();
  const asked = s.ask(inputOf('one-auto'));
  await until(() => s.questions().length === 1, 'the question');
  s.choose(s.questions()[0], [], 'Teal, please');
  const answer = await asked;
  assert.equal(Object.values(answer.updatedInput.answers)[0], 'Teal, please');
  await until(() => !s.rt.turns.size, 'the first turn to end');

  const two = s.ask(inputOf('two-auto'));
  await until(() => s.questions().length === 2, 'the next turn’s first question');
  s.rt.act(s.t.id, s.questions()[1].id, 'dismiss', {});
  assert.deepEqual(await two, { behavior: 'deny', message: 'The person dismissed the question.' });
  await until(() => !s.rt.turns.size, 'the turn to end');
  assert.equal(s.questions().length, 2, 'the second question was never shown');
});

test('#521 a waiting question needs the person mid-turn, and answering it lets go', async () => {
  const s = setup();
  const asked = s.ask(inputOf('one-auto'));
  await until(() => s.questions().length === 1, 'the question');
  const [q] = s.questions();
  assert.equal(s.se().needs?.itemId, q.id, 'the question is what the agent needs, while its turn runs');
  s.choose(q, ['Red']);
  await asked;
  await until(() => !s.rt.turns.size, 'the turn to end');
  assert.notEqual(s.se().needs?.itemId, q.id, 'answered, it no longer needs the person');
});

test('#521 a card answered while a question waits gives the need back to the question', async () => {
  const s = setup();
  let card;
  const asked = new Promise((done) => {
    s.adapter.next.push(async (c) => {
      const question = canUseTool(c, 'AskUserQuestion', inputOf('one-auto'), { toolUseID: 'toolu_ask_2' });
      await until(() => s.questions().length === 1, 'the question');
      // A subagent asks permission while the question waits: its card takes the need, as a permission does.
      card = c.askPermission({ tool: 'Bash', summary: 'run a command', input: { command: 'ls' }, agentId: 'sub-1' });
      done(await question);
      await card;
      c.text('Done.');
    });
  });
  s.rt.sendMessage(s.t.id, { text: 'Ask me.' });
  await until(() => s.items().some((i) => i.kind === 'permission' && i.status === 'open'), 'the subagent’s card');
  const open = s.items().find((i) => i.kind === 'permission' && i.status === 'open');
  assert.equal(s.se().needs?.itemId, open.id, 'the card is the need first');
  s.rt.act(s.t.id, open.id, 'allow', {});
  const [q] = s.questions();
  await until(() => s.se().needs?.itemId === q.id, 'the need back on the waiting question');
  s.choose(q, ['Red']);
  assert.equal((await asked).behavior, 'allow');
});

test('#521 a turn stopped while a question waits tells the agent it stays open, and its answer later comes as an event', async () => {
  const s = setup();
  const asked = s.ask(inputOf('two-auto'));
  await until(() => s.questions().length === 1, 'the first question');
  s.choose(s.questions()[0], ['Red']);
  await until(() => s.questions().length === 2, 'the second question');
  s.rt.stop(s.se().id);
  const answer = await asked;
  assert.equal(answer.behavior, 'deny');
  assert.ok(answer.message.startsWith('You stopped the agent.'), `the agent hears why it ended, as a stopped card’s call does: ${answer.message}`);
  assert.ok(answer.message.includes(STILL_OPEN), `the agent hears the question is still open: ${answer.message}`);
  assert.ok(answer.message.includes('“Which color?”: Red'), `and what the person already answered: ${answer.message}`);
  await until(() => !s.rt.turns.size, 'the turn to end');
  const left = s.questions()[1];
  assert.equal(s.store.item(s.t.id, left.id).answered, false, 'the block stays, still asking');
  assert.equal(s.store.item(s.t.id, left.id).status, undefined, 'and isn’t closed as an expired card');
  s.choose(left, ['Pear']);
  await until(() => s.delivered.some((m) => m.kind === 'event' && m.blockItemId === left.id), 'its answer as an event');
});

test('#521 a question past the catalog’s limits keeps today’s permission card', async () => {
  const s = setup();
  const input = inputOf('one-auto');
  input.questions[0].options = Array.from({ length: 25 }, (_, i) => ({ label: `Option ${i + 1}`, description: 'One of many.' }));
  const asked = s.ask(input);
  await until(() => s.items().some((i) => i.kind === 'permission' && i.status === 'open'), 'a permission card');
  assert.equal(s.questions().length, 0, 'no question block');
  const card = s.items().find((i) => i.kind === 'permission' && i.status === 'open');
  s.rt.act(s.t.id, card.id, 'deny', {});
  assert.equal((await asked).behavior, 'deny');
});

test('#521 a question on a host keeps today’s permission card', async () => {
  const s = setup();
  let asked;
  s.adapter.next.push(async (c) => {
    asked = s.rt.requestPermission(s.se().id, {
      tool: 'AskUserQuestion',
      summary: 'use AskUserQuestion',
      input: inputOf('one-auto'),
      hostPrompt: { hostId: 'h1', turn: 'ht1', id: 'p1' },
    });
    await asked;
    c.text('Done.');
  });
  s.rt.sendMessage(s.t.id, { text: 'Ask me.' });
  await until(() => s.items().some((i) => i.kind === 'permission' && i.status === 'open'), 'the host prompt’s card');
  assert.equal(s.questions().length, 0, 'no question block');
  s.rt.act(s.t.id, s.items().find((i) => i.kind === 'permission' && i.status === 'open').id, 'deny', {});
  assert.equal((await asked).allow, false);
});

test('#521 a question nobody answers within CARD_WAIT_MS stays open, and the agent hears one thing: don’t ask again', async () => {
  const s = setup();
  // The question’s timer is armed when its block shows, so the clock is faked from before the ask; the wait for the
  // block polls without timers.
  mock.timers.enable({ apis: ['setTimeout'] });
  let answer;
  /** @type {() => void} */
  let goOn = () => {};
  const held = new Promise((r) => {
    goOn = r;
  });
  try {
    // The turn goes on after the call is refused, as an SDK turn does, until the test lets it end.
    const asked = new Promise((r) => {
      s.adapter.next.push(async (c) => {
        r(await canUseTool(c, 'AskUserQuestion', inputOf('one-auto'), { toolUseID: 'toolu_ask_9' }));
        await held;
        c.text('Done.');
      });
    });
    s.rt.sendMessage(s.t.id, { text: 'Ask me.' });
    for (let i = 0; i < 2000 && s.questions().length === 0; i++) await new Promise((r) => setImmediate(r));
    assert.equal(s.questions().length, 1, 'the question');
    mock.timers.tick(CARD_WAIT_MS);
    answer = await asked;
  } finally {
    mock.timers.reset();
  }
  assert.ok(s.rt.turns.size, 'the turn still runs');
  assert.notEqual(s.se().needs?.itemId, s.questions()[0].id, 'no call waits on it now, so it isn’t what the running turn needs');
  goOn();
  await until(() => !s.rt.turns.size, 'the turn to end');
  assert.equal(answer.behavior, 'deny');
  assert.ok(answer.message.includes(STILL_OPEN), answer.message);
  assert.ok(!/ask again if/i.test(answer.message), `no “ask again” beside “don’t ask it again”: ${answer.message}`);
  assert.equal(s.store.item(s.t.id, s.questions()[0].id).answered, false, 'the block stays asking');
});
