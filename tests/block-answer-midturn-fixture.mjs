// What the #1810 specs share: a block the agent showed, answered by the person while a later turn of its waits, and
// the messages its turns were given that carry the answer. Moved out of tests/block-answer-midturn.test.mjs.
import { sessionsIn } from './arrange.mjs';
import { review, settle, setup, turn } from './blocks-fixture.mjs';

export const COMMENTS = [
  { line: 1, text: 'Name the owner.' },
  { line: 1, text: 'Say when it ships.' },
];

/** Every message a turn was given that carries the block’s answer, as an event or inside a batch. */
export const answersGiven = (adapter, itemId) =>
  adapter.calls.flatMap((c) => c.message.messages ?? [c.message]).filter((m) => m.kind === 'event' && m.blockItemId === itemId);

/**
 * The block shown, then a turn that waits until the test lets it go, and then calls `step` with its tools. The person
 * answers while it waits, and `during` runs once they have, before the turn goes on.
 */
export async function answeredMidTurn({ during = () => {}, comments = COMMENTS } = {}) {
  const s = setup();
  const { rt, store, t, adapter } = s;
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: review }));
  const item = store.items(t.id).find((i) => i.kind === 'block');
  const se = sessionsIn(rt, t.id)[0];
  let go = () => {};
  let started = () => {};
  const running = new Promise((r) => {
    started = r;
  });
  const replies = [];
  adapter.next.push(async (c) => {
    await new Promise((r) => {
      go = r;
      started();
    });
    replies.push(c.tools.update_block({ block: { ...review, content: '# Draft 2' } }));
    replies.push(c.tools.update_block({ block: { ...review, content: '# Draft 2' } }));
  });
  rt.sendMessage(t.id, { text: 'keep working' });
  await running;
  rt.act(t.id, item.id, 'submit', { verdict: 'request_changes', comments }, 1);
  during({ ...s, item, se });
  const calls = adapter.calls.length;
  go();
  await settle(rt);
  return { ...s, item, se, replies, calls };
}
