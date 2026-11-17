// A host’s tool call from a turn Postbox no longer runs (#612, #759): it’s refused, since nothing owns it, and a queued
// call’s agent, who heard “sent” from the shim once the daemon took it, finds the refusal waiting as a notice entry at
// its next turn, not lost without a word. Postbox hears a host while a turn needs it, so the late call comes during
// the agent’s next turn there. Over the real Claude Code adapter and tests/fake-daemon.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STOPPED_TEXT } from '../server/remote/turns.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

const refusal = (r, id) => r.link.sent.find((m) => m.type === 'reply' && m.id === id);

test('#612 a queued call from a turn that has ended is refused, and its agent finds the refusal as a notice', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.end(turn);
  await settled(r);
  const next = await running(r, 'again');
  r.link.hear({ type: 'tool', turn, id: 'late', name: 'define_term', args: { term: 'x', definition: 'y' } });
  await until(() => refusal(r, 'late'), 'the late call’s refusal');
  assert.deepEqual((({ ok, text }) => ({ ok, text }))(refusal(r, 'late')), { ok: false, text: STOPPED_TEXT });
  assert.equal(r.store.state.glossary[r.t.id]?.x, undefined);
  const notices = (r.store.state.inbox[r.se().id] ?? []).filter((e) => e.source === 'notice');
  assert.deepEqual(
    notices.map((e) => e.state),
    ['waiting'],
    'it waits to ride the agent’s next turn',
  );
  assert.match(notices[0].text, /define_term call from the host didn’t go through/);
  r.d.end(next);
  await settled(r);
});

test('#612 an asked call from a turn that has ended gets the refusal as its answer, and no notice', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.end(turn);
  await settled(r);
  const next = await running(r, 'again');
  r.link.hear({ type: 'tool', turn, id: 'asked', name: 'search_assets', args: { query: 'whales' } });
  await until(() => refusal(r, 'asked'), 'the asked call’s refusal');
  assert.equal(refusal(r, 'asked').ok, false);
  assert.deepEqual(
    (r.store.state.inbox[r.se().id] ?? []).filter((e) => e.source === 'notice'),
    [],
  );
  r.d.end(next);
  await settled(r);
});

test('#612 a late call the host sends again is refused again, and leaves one notice', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.end(turn);
  await settled(r);
  const next = await running(r, 'again');
  const call = { type: 'tool', turn, id: 'late', name: 'define_term', args: { term: 'x', definition: 'y' } };
  r.link.hear(call);
  await until(() => refusal(r, 'late'), 'the first refusal');
  r.link.hear(call);
  await until(() => r.link.sent.filter((m) => m.type === 'reply' && m.id === 'late').length === 2, 'the second refusal');
  assert.equal((r.store.state.inbox[r.se().id] ?? []).filter((e) => e.source === 'notice').length, 1);
  r.d.end(next);
  await settled(r);
});
