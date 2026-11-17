// Links in an agent’s reply to what Work’s viewer opens (#1446): inline code that names one of the room’s assets or
// one of the conversation’s changed files, and any asset id in the text. Each becomes a link to the pane’s own address
// (`?work&at=<id>`), so it opens beside the conversation, and a reload or a new tab opens it again. The text stays the
// same text node, moved into an <a> made with h(). It runs with the diagrams and math (md-enhance.mjs), when a reply is
// drawn; one drawn again is linked again, and one already linked is left as it is.

import { ASSET_ID, conversationOf, hasRefs, refLookup } from '/shared/room-refs.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { openWork, paneHref } from './ui.mjs';

/**
 * The lookup for a conversation, kept while the state is the same: a room’s replies are drawn together, and a long
 * room mounts them as you scroll. `any` says whether the conversation has anything to link: with no live asset and no
 * changed file, a reply costs no DOM query at all (#1447 review: the pass slowed a scroll back in a room with none).
 */
let cached = { key: '', any: false, find: (/** @type {string} */ _t) => /** @type {import('/shared/room-refs.mjs').Ref | null} */ (null) };
function lookupFor(convId) {
  const key = `${convId}\u0000${client.seq}`;
  if (cached.key !== key) cached = { key, any: hasRefs(client.state, convId), find: refLookup(client.state, convId) };
  return cached;
}

/** The link around a node: to the pane, opened in place unless a modifier asks for a new tab. */
function link(convId, at, node) {
  return h(
    'a.room-ref',
    {
      href: paneHref(convId, { work: true, at }),
      onclick: (/** @type {MouseEvent} */ e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        openWork(convId, { at });
      },
    },
    node,
  );
}

/**
 * Text nodes under root that hold an asset id’s prefix and aren’t in code, a link or a code block. Walked only when the
 * reply’s text has the prefix at all, and a node is checked for where it sits only once its text has it.
 * @param {Element} root
 */
function plainText(root) {
  const out = [];
  if (!root.textContent?.includes('as_')) return out;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.includes('as_') && !n.parentElement?.closest('a, code, pre')) out.push(n);
  return out;
}

/** Splits a text node at each asset id the room has, each id into a link. */
function linkIds(convId, find, node) {
  const text = node.textContent ?? '';
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(ASSET_ID)) {
    if (!find(m[0])) continue;
    parts.push(text.slice(last, m.index), link(convId, m[0], m[0]));
    last = m.index + m[0].length;
  }
  if (!parts.length) return;
  node.replaceWith(...parts, text.slice(last));
}

/**
 * Links what a reply names, in a box inside a conversation’s transcript or thread ([data-thread]).
 * @param {Element} root
 */
export function linkRoomRefs(root) {
  const threadId = root.closest('[data-thread]')?.getAttribute('data-thread');
  const threads = client.state?.threads;
  if (!threadId || !threads?.[threadId]) return;
  const convId = conversationOf(threads, threadId);
  const { any, find } = lookupFor(convId);
  if (!any) return;
  const codes = [...root.querySelectorAll('code')].filter((c) => !c.closest('a, pre'));
  const ids = plainText(root);
  for (const code of codes) {
    const ref = find(code.textContent ?? '');
    if (!ref) continue;
    const a = link(convId, ref.at, null);
    code.replaceWith(a);
    a.append(code);
  }
  for (const n of ids) linkIds(convId, find, n);
}
