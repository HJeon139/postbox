// What a conversation’s search reads of an item (#866, W4): the words the item shows. A message’s text; a block’s
// title, prompt or statement, fallback, and what it lays out that the fallback may not hold (a card’s body and facts,
// a choice’s options, a form’s field labels, a review’s or a code block’s content); an app’s title only, as its
// content lives in its sandbox. Not tool output or activity steps. A reply still streaming, or replaced by a replay,
// has no search text yet, so it isn’t found.

/** @param {unknown} v */
function str(v) {
  if (typeof v === 'string') return v;
  return typeof v === 'number' ? String(v) : '';
}

/** A block’s own words, by type. @param {any} b */
function blockText(b) {
  const parts = [b.title, b.prompt, b.statement, b.fallback];
  if (b.type === 'app') return str(b.title);
  if (b.type === 'card') parts.push(b.body, ...(b.facts ?? []).flatMap((/** @type {any} */ f) => [f?.label, f?.value]));
  if (b.type === 'choice') parts.push(...(b.options ?? []).flatMap((/** @type {any} */ o) => [o?.label, o?.description]));
  if (b.type === 'form') parts.push(...(b.fields ?? []).map((/** @type {any} */ f) => f?.label));
  if (b.type === 'review' || b.type === 'code') parts.push(b.content, b.code);
  return parts.map(str).filter(Boolean).join('\n');
}

/**
 * The text search indexes for an item, or '' for one it skips.
 * @param {any} it
 */
export function searchText(it) {
  if (!it || it.status === 'streaming' || it.status === 'replaced') return '';
  if (it.kind === 'user' || it.kind === 'agent' || it.kind === 'shared') return str(it.text);
  if (it.kind === 'block' && it.valid && it.block) return blockText(it.block);
  return '';
}
