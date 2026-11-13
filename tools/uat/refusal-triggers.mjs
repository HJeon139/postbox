// #1319's UAT triggers (tools/uat/triggers.mjs has what a trigger is): Postbox refused an agent’s malformed app or
// block outright, with what to fix, and the agent then showed it fixed, with no broken card left in the room. Read
// from the recorded streams’ Postbox calls and the room’s items. Whether the fixed one looks right is the tester’s.

import { postboxCalls } from './postbox-calls.mjs';
import { itemsUnderTest } from './remote-facts.mjs';
import { clip } from './trigger-facts.mjs';

/** server/block-show.mjs’s refusal, through shared/block-examples.mjs’s notShown. */
const REFUSED = /^The block wasn’t shown: /;

/** Whether a call shows an app: show_app, or show_block with an app block. @param {{ name: string, input: any }} c */
const showsApp = (c) => c.name === 'show_app' || (c.name === 'show_block' && c.input?.block?.type === 'app');
/** Whether a call shows a block that isn’t an app. @param {{ name: string, input: any }} c */
const showsBlock = (c) => c.name === 'show_block' && c.input?.block?.type !== 'app';

/** The id a call shows its app or block under, or undefined when it gave none. @param {{ name: string, input: any }} c */
const idOf = (c) => {
  const id = c.name === 'show_app' ? c.input?.id : c.input?.block?.id;
  return typeof id === 'string' ? id : undefined;
};

/** Whether the room holds a block Postbox should have refused (the broken-block-card check’s). @param {any} f */
const brokenCard = (f) => itemsUnderTest(f).some((it) => it.kind === 'block' && it.valid === false && it.reason === 'invalid');

/**
 * Each refusal of a call of this kind that the same agent followed with one Postbox took under the same id: the
 * refused one fixed, not another shown beside it under a new id, as agents did before #1319.
 * @param {any} f @param {(c: any) => boolean} kind
 */
function refusedThenShown(f, kind) {
  if (brokenCard(f)) return [];
  const calls = postboxCalls(f.streams).filter(kind);
  return calls.flatMap((c, i) => {
    const id = idOf(c);
    if (!c.error || !REFUSED.test(c.text) || id === undefined) return [];
    const fixed = calls.slice(i + 1).find((x) => x.handle === c.handle && idOf(x) === id && !x.error);
    if (!fixed) return [];
    return [
      {
        at: fixed.at,
        evidence: `@${c.handle}’s ${c.name} of ${id} was refused (“${clip(c.text.replace(REFUSED, ''), 120)}”), then its ${fixed.name} of ${id} was taken: “${clip(fixed.text, 80)}”. No broken card is in the room.`,
      },
    ];
  });
}

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const REFUSAL_TRIGGERS = {
  'app-refused-then-shown': {
    issue: 1319,
    says: 'it refused an agent’s malformed app with what to fix, leaving nothing in the conversation, and the agent then showed the app fixed',
    recorded: (f) => Array.isArray(f.streams) && !!f.state,
    run: (f) => refusedThenShown(f, showsApp),
  },
  'block-refused-then-shown': {
    issue: 1319,
    says: 'it refused an agent’s malformed block with what to fix, leaving nothing in the conversation, and the agent then showed the block fixed',
    recorded: (f) => Array.isArray(f.streams) && !!f.state,
    run: (f) => refusedThenShown(f, showsBlock),
  },
};
