// Agents’ reactions: an agent reacts to any message, block or app in its conversation, its own included, with
// Postbox’s react tool. Each reactor has their own reaction; the agent whose message it is hears an agent’s at its next
// turn, and no one else does; none wakes anyone. Telemetry reads an agent’s 🚩 as a flag, with who made it
// (designs/telemetry-persona.md, R9).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_DEFS } from '../server/mcp.mjs';
import { reactTool } from '../server/reactions.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
import { flaggedRoom, report } from './telemetry-fixture.mjs';

/** A room where alpha has replied to the person once, and the reply. */
async function replied() {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('The parser drops entries whose year sits in a note field.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha why is the list short?' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((x) => x.kind === 'agent');
  const question = f.store.items(f.t.id).find((x) => x.kind === 'user');
  const alpha = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'alpha');
  const beta = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'beta');
  return { ...f, reply, question, alpha, beta };
}
/** What each agent’s next turn starts with. */
async function nextTurns(f, text) {
  const before = f.adapter.calls.length;
  f.rt.sendMessage(f.t.id, { text });
  await settle(f.rt);
  return Object.fromEntries(f.adapter.calls.slice(before).map((c) => [c.handle, (c.message.context ?? []).join('\n')]));
}

test('agents react with the react tool, which every agent has, to any message: the person’s, another agent’s, its own', async () => {
  const f = await replied();
  const def = TOOL_DEFS.find((t) => t.name === 'react');
  assert.deepEqual(def?.inputSchema.required, ['id', 'emoji']);
  assert.match(reactTool(f.rt, f.beta, { id: f.question.id, emoji: '👍' }).message, /You reacted 👍 to the person’s message/);
  assert.match(reactTool(f.rt, f.beta, { id: f.reply.id, emoji: '🚩' }).message, /You reacted 🚩 to @alpha’s message/);
  assert.match(reactTool(f.rt, f.alpha, { id: f.reply.id, emoji: '✅' }).message, /You reacted ✅ to your own message/);
  assert.deepEqual(
    f.store.item(f.t.id, f.reply.id).reactions.map((r) => [r.emoji, r.handle]),
    [
      ['🚩', 'beta'],
      ['✅', 'alpha'],
    ],
  );
  assert.equal(reactTool(f.rt, f.beta, { id: f.reply.id, emoji: '🎉' }).ok, false);
  assert.match(reactTool(f.rt, f.beta, { id: 'it_nowhere', emoji: '👍' }).message, /no item/);
  assert.equal(f.rt.turns.size, 0, 'a reaction wakes no one');
});

test('each reactor has their own: the person taking back their 👍 leaves an agent’s, and an agent’s again takes back only its own', async () => {
  const f = await replied();
  f.rt.act(f.t.id, f.reply.id, '@react', { emoji: '👍' });
  reactTool(f.rt, f.beta, { id: f.reply.id, emoji: '👍' });
  assert.equal(f.store.item(f.t.id, f.reply.id).reactions.length, 2);
  f.rt.act(f.t.id, f.reply.id, '@react', { emoji: '👍' });
  assert.deepEqual(
    f.store.item(f.t.id, f.reply.id).reactions.map((r) => r.handle),
    ['beta'],
  );
  assert.match(reactTool(f.rt, f.beta, { id: f.reply.id, emoji: '👍' }).message, /took back your 👍/);
  assert.deepEqual(f.store.item(f.t.id, f.reply.id).reactions, []);
});

test('the agent whose message it is hears an agent’s reaction at its next turn, once; the reactor and others don’t', async () => {
  const f = await replied();
  reactTool(f.rt, f.beta, { id: f.reply.id, emoji: '👎' });
  const turns = await nextTurns(f, '@alpha @beta what next?');
  assert.match(turns.alpha, /@beta reacted 👎 to your message at \d\d:\d\d: “The parser drops entries/);
  assert.doesNotMatch(turns.beta, /reacted/);
  const again = await nextTurns(f, '@alpha and now?');
  assert.doesNotMatch(again.alpha, /reacted/);
  // An agent’s reaction to its own message tells no one.
  reactTool(f.rt, f.alpha, { id: f.reply.id, emoji: '✅' });
  const own = await nextTurns(f, '@alpha @beta anything?');
  assert.doesNotMatch(`${own.alpha}\n${own.beta}`, /reacted/);
});

test('read_conversation gives each item’s id, which react takes', async () => {
  const f = await replied();
  const read = f.rt.toolsFor(f.beta.id).read_conversation({}).message;
  const id = /\[(it_\w+)\] @alpha: The parser/.exec(read)?.[1];
  assert.equal(id, f.reply.id);
  assert.equal(reactTool(f.rt, f.beta, { id, emoji: '❓' }).ok, true);
});

test('R9: an agent’s 🚩 is a flag in a telemetry report, with who made it, and is labeled like the person’s', async () => {
  const f = await flaggedRoom();
  const beta = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'beta');
  reactTool(f.rt, beta, { id: f.reply.id, emoji: '🚩' });
  const { draft } = await report(f);
  const flags = draft.report.reactions.filter((r) => r.emoji === '🚩');
  assert.deepEqual(flags.map((r) => r.by).sort(), ['agent-2', 'person']);
  assert.ok(flags.every((r) => draft.report.labels.some((l) => l.on === r.ref && l.mast)));
  f.stop();
});
