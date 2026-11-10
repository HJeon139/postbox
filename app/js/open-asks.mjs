// Open blocks (#69): asking blocks you left open from an earlier turn, shown quietly beside their agent as
// “1 open review”, a button under an agent’s row and in its quick panel.

import { ASKING } from '/shared/catalog.mjs';
import { client, itemsOf } from './client.mjs';
import { h, plural } from './dom.mjs';
import { WeakElements } from './held-weakly.mjs';
import { focusItem } from './needs-nav.mjs';

const S = () => client.state;

// ── Open blocks ─────────────────────────────────────────────────────────────────────────
// Asking blocks you left open from an earlier turn don’t make their agent need you. They show quietly
// beside it instead, as “1 open review”, and stay open so you can still answer them (#69).

const ASK_NOUNS = { choice: ['choice', 'choices'], form: ['form', 'forms'], confirm: ['confirmation', 'confirmations'], review: ['review', 'reviews'] };
// Each session’s open asking blocks, found once and kept until an item, a thread or a removal changes: a session event, the
// most frequent one, only changes which of them is the need, so it reads this list, not every item (#564-b1).
/** @type {Map<string, any[]>} */
const asking = new Map();
/** The session’s open asking blocks: its own thread’s, and those it showed in a side thread of it (#110). */
function askingOf(se) {
  const kept = asking.get(se.id);
  if (kept) return kept;
  const threads = [
    se.threadId,
    ...Object.values(S().threads)
      .filter((t) => t.kind === 'side' && t.parentId === se.threadId)
      .map((t) => t.id),
  ];
  const found = threads.flatMap(itemsOf).filter((it) => it.kind === 'block' && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered);
  asking.set(se.id, found);
  return found;
}
/** @returns {{ text: string, itemId: string } | null} */
export function openAsks(se) {
  const open = askingOf(se).filter((it) => it.id !== se.needs?.itemId);
  if (!open.length) return null;
  const types = new Set(open.map((it) => it.block.type));
  const [one, many] = types.size === 1 ? ASK_NOUNS[open[0].block.type] : ['request', 'requests'];
  return { text: plural(open.length, `open ${one}`, `open ${many}`), itemId: open[0].id };
}
/**
 * “1 open review” for an agent: a button that goes to the block.
 * @param {any} se @param {() => void} [before] what to do first, such as close the panel it’s in
 */
export function openAsksEl(se, before = undefined) {
  const el = h('button.btn.sm.ghost', {
    type: 'button',
    dataset: { openAsks: se.id },
    onclick: () => {
      before?.();
      void focusItem(el.dataset.item ?? '');
    },
  });
  paintOpenAsks(el);
  buttons.add(el);
  return el;
}
// The buttons drawn, kept here rather than found by a query over the whole page (#564-b1). One off the page is skipped,
// not painted, since it may come back; only a long list lets go of those. They’re held weakly, so one the page has let
// go of is let go of here too, not kept with its whole old page (#866, held-weakly.mjs).
const buttons = new WeakElements();
const KEEP = 32;
// What can change a session’s open blocks: any item change but streamed text, a removal, a thread, a load.
const CHANGES_BLOCKS = (/** @type {string} */ type) => (type.startsWith('item.') && type !== 'item.text') || ['remove', 'thread', 'load'].includes(type);
function paintOpenAsks(el) {
  const se = S().sessions[el.dataset.openAsks];
  const ask = se ? openAsks(se) : null;
  el.hidden = !ask;
  if (el.textContent !== (ask?.text ?? '')) el.textContent = ask?.text ?? '';
  if (ask) el.dataset.item = ask.itemId;
  if (ask) el.setAttribute('aria-label', `${ask.text} from ${se.handle}: go to it`);
}
client.on((ch) => {
  const blocks = CHANGES_BLOCKS(ch.type);
  if (blocks) asking.clear();
  if (ch.type !== 'session' && !blocks) return;
  // A session event repaints only that session’s buttons; a change to the blocks, all of them.
  const only = ch.type === 'session' ? ch.data.id : null;
  if (buttons.size > KEEP) for (const el of buttons) if (!el.isConnected) buttons.delete(el);
  for (const el of buttons) if (el.isConnected && (!only || el.dataset.openAsks === only)) paintOpenAsks(el);
});
