// Open blocks (#69): asking blocks you left open from an earlier turn, shown quietly beside their agent as
// “1 open review”, on an agent’s row and its overview card.

import { ASKING } from '/shared/catalog.mjs';
import { client, itemsOf } from './client.mjs';
import { h, plural } from './dom.mjs';

const S = () => client.state;

// ── Open blocks ─────────────────────────────────────────────────────────────────────────
// Asking blocks you left open from an earlier turn don’t make their agent need you. They show quietly
// beside it instead, as “1 open review”, and stay open so you can still answer them (#69).

const ASK_NOUNS = { choice: ['choice', 'choices'], form: ['form', 'forms'], confirm: ['confirmation', 'confirmations'], review: ['review', 'reviews'] };
/** @returns {{ text: string, itemId: string } | null} */
export function openAsks(se) {
  // Its own thread’s, and those it showed while answering in a side thread of it (#110).
  const threads = [
    se.threadId,
    ...Object.values(S().threads)
      .filter((t) => t.kind === 'side' && t.parentId === se.threadId)
      .map((t) => t.id),
  ];
  const open = threads
    .flatMap(itemsOf)
    .filter((it) => it.kind === 'block' && it.sessionId === se.id && it.valid && ASKING.has(it.block.type) && !it.answered && it.id !== se.needs?.itemId);
  if (!open.length) return null;
  const types = new Set(open.map((it) => it.block.type));
  const [one, many] = types.size === 1 ? ASK_NOUNS[open[0].block.type] : ['request', 'requests'];
  return { text: plural(open.length, `open ${one}`, `open ${many}`), itemId: open[0].id };
}
/**
 * “1 open review” for an agent: quiet text on its overview card, or a button in its row that goes to the block.
 * @param {any} se @param {boolean} [button] @param {() => void} [before] what to do first, such as close the panel it’s in
 */
export function openAsksEl(se, button = false, before = undefined) {
  const el = button
    ? h('button.btn.sm.ghost', {
        type: 'button',
        dataset: { openAsks: se.id },
        onclick: () => {
          before?.();
          goToItem(el.dataset.item);
        },
      })
    : h('span.small.dim', { dataset: { openAsks: se.id } });
  paintOpenAsks(el);
  return el;
}
function paintOpenAsks(el) {
  const se = S().sessions[el.dataset.openAsks];
  const ask = se ? openAsks(se) : null;
  el.hidden = !ask;
  if (el.textContent !== (ask?.text ?? '')) el.textContent = ask?.text ?? '';
  if (ask) el.dataset.item = ask.itemId;
  if (ask && el.tagName === 'BUTTON') el.setAttribute('aria-label', `${ask.text} from @${se.handle}: go to it`);
}
client.on((ch) => {
  if (['session', 'item.add', 'item.patch', 'load'].includes(ch.type)) for (const el of document.querySelectorAll('[data-open-asks]')) paintOpenAsks(el);
});

/** Scrolls to an item in the transcript or the thread panel, and focuses what can be answered in it. */
function goToItem(itemId) {
  const node = document.querySelector(`[data-key="${CSS.escape(itemId ?? '')}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  (node.querySelector('button:not([disabled]), input, textarea, select') ?? node).focus();
}
