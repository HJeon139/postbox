// End on a subagent’s row (#229): Postbox can’t stop one subagent inside its agent’s turn, so it tells the agent,
// urgently, to stop it and not use its result. The note reaches the agent on its next Postbox tool result in the
// turn, or else at its next turn, and the row reads “ending” until the subagent or the turn ends.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { settle, setup, sleep } from './side-threads-fixture.mjs';

/** @alpha’s turn with a subagent at work, held until release(). */
function withSubagent() {
  const ctx = setup();
  const { rt, adapter, t } = ctx;
  let release = () => {};
  const done = new Promise((r) => {
    release = () => r(undefined);
  });
  adapter.next.push(async (c) => {
    c.status({ state: 'tool', subagents: [{ id: 'toolu_reader', name: 'general-purpose', state: 'tool', asked: 'Count the words' }] });
    await done;
    c.text('Done.');
  });
  rt.sendMessage(t.id, { text: '@alpha count them, with a subagent' });
  return { ...ctx, release: () => release() };
}
const call = (rt, se, name, args) =>
  handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, rt.turns.get(se.id)?.token ?? null);

test('#229: End marks the subagent ending, and the agent hears it on its next Postbox tool result in the turn, once', async () => {
  const { store, rt, adapter, t, alpha, release } = withSubagent();
  await sleep(5);
  assert.deepEqual(rt.requestStop(alpha.id, { subagent: 'toolu_reader' }), { ending: true });
  assert.ok(rt.turns.has(alpha.id), 'the turn goes on: only the agent can stop one subagent');
  assert.deepEqual(store.state.sessions[alpha.id].endingSubagents, ['toolu_reader']);
  const r = await call(rt, alpha, 'define_term', { term: 'Word', definition: 'A run of letters.' });
  const text = r.result.content[0].text;
  assert.match(
    text,
    /^\[Postbox\] URGENT: the person ended your subagent general-purpose, asked “Count the words” \(id toolu_reader\)\. If it’s still running, stop it now with your own tools, and don’t use its result\.\n\n/,
  );
  assert.match(text, /Defined “Word”\.$/);
  const again = await call(rt, alpha, 'define_term', { term: 'Line', definition: 'A run of words.' });
  assert.doesNotMatch(again.result.content[0].text, /URGENT/, 'it’s told once');
  release();
  await settle(rt);
  rt.sendMessage(t.id, { text: '@alpha next' });
  await settle(rt);
  assert.doesNotMatch((adapter.calls.at(-1).message.context ?? []).join('\n'), /URGENT/, 'not again at the next turn');
  assert.deepEqual(store.state.sessions[alpha.id].endingSubagents, [], 'a new turn starts with none ending');
});

test('#229: with no Postbox tool call before the turn ends, the note isn’t given at the next turn; a subagent that ended can’t be ended', async () => {
  const { rt, adapter, t, alpha, release } = withSubagent();
  await sleep(5);
  rt.requestStop(alpha.id, { subagent: 'toolu_reader' });
  assert.deepEqual(rt.requestStop(alpha.id, { subagent: 'toolu_reader' }), { ending: true }, 'a second press changes nothing');
  assert.equal(rt.s.sessions[alpha.id].context.filter((x) => x.includes('URGENT')).length, 1);
  release();
  await settle(rt);
  assert.throws(() => rt.requestStop(alpha.id, { subagent: 'toolu_reader' }), /That subagent has already ended/);
  rt.sendMessage(t.id, { text: '@alpha next' });
  await settle(rt);
  // The subagent ended with its turn: there’s nothing left to stop.
  assert.doesNotMatch((adapter.calls.at(-1).message.context ?? []).join('\n'), /URGENT/);
});
