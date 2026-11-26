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
 * The block shown, then a turn that waits until the test lets it go, and then tries to update it twice, to `revised`.
 * The person answers while it waits (`act`: by default a review’s verdict with `comments`), and `during` runs once they
 * have, before the turn goes on. `update` makes each try from the turn’s context, by default through its own tools.
 * @param {{ during?: (f: any) => void, comments?: any[], block?: any, revised?: any, act?: [string, any],
 *   update?: (c: any, block: any, f: any) => any }} [o]
 */
export async function answeredMidTurn({
  during = () => {},
  comments = COMMENTS,
  block = review,
  revised = { ...review, content: '# Draft 2' },
  act = ['submit', { verdict: 'request_changes', comments }],
  update = (c, b) => c.tools.update_block({ block: b }),
} = {}) {
  const s = setup();
  const { rt, store, t, adapter } = s;
  await turn(rt, adapter, t, (tools) => tools.show_block({ block }));
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
    replies.push(await update(c, revised, { ...s, item, se }));
    replies.push(await update(c, revised, { ...s, item, se }));
  });
  rt.sendMessage(t.id, { text: 'keep working' });
  await running;
  rt.act(t.id, item.id, act[0], act[1], 1);
  during({ ...s, item, se });
  const calls = adapter.calls.length;
  go();
  await settle(rt);
  return { ...s, item, se, replies, calls };
}
