// An agent’s text as Markdown (thread.mjs): its citations, @mentions, and glossary terms, marked when they aren’t
// defined yet. A term’s glossary is its thread’s, over the conversation’s it branched from.

import { renderMarkdown } from '/shared/markdown.mjs';
import { textFrom } from './activity-live.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { writeMarkdown } from './md-patch.mjs';
import { forgetStreaming, writeStreaming } from './md-stream.mjs';

const S = () => client.state;
export const handles = () =>
  Object.values(S().personas)
    .filter((p) => !p.retired)
    .map((p) => p.handle);
const glossaryOf = (threadId) => {
  const t = S().threads[threadId];
  const g = { ...(S().glossary[t?.parentId] ?? {}), ...(S().glossary[threadId] ?? {}) };
  return g;
};

export function agentMarkdown(it, threadId) {
  const answer = renderMarkdown(it.text ?? '', markdownOpts(it, threadId));
  // A shared reply’s question (#111) is the person’s own message, drawn as theirs is, and apart from the answer: its
  // Markdown, a fence or a heading, can’t run into the answer’s.
  if (it.kind !== 'shared' || !it.question) return answer;
  return `<div class="shared-q"><span class="shared-q-label">You asked</span>${renderMarkdown(it.question, { mentions: handles() })}</div>${answer}`;
}

/** How an agent's text renders: its citations, its thread's glossary and the room's handles. @param {any} it @param {string} threadId */
const markdownOpts = (it, threadId) => ({
  streaming: it.status === 'streaming',
  citations: it.sources?.length ?? 0,
  citeId: `src-${it.id}`,
  glossary: Object.values(glossaryOf(threadId)).map((g) => ({ key: g.key, term: g.term })),
  mentions: handles(),
});

export function markTerms(root, threadId) {
  const g = glossaryOf(threadId);
  for (const t of root.querySelectorAll('.term')) {
    // Own keys only, as hover-content.mjs reads it: a term like “constructor” would read Object’s. The same class of
    // bug as #247, a form’s receipt.
    const known = !!(t.dataset.term && Object.hasOwn(g, t.dataset.term) && g[t.dataset.term]);
    t.classList.toggle('undef', !known);
    if (!known) t.title = 'Not defined yet. The agent has been asked to define it.';
  }
}

/**
 * Draws an agent's text into its box, block by block (#564), with its terms marked and, while it streams, the caret.
 * @param {Element} box  @param {any} it  @param {string} threadId
 */
export function paintAgentMarkdown(box, it, threadId) {
  box.querySelector(':scope > .caret')?.remove();
  // While the turn runs, its words before its last step are drawn between its steps (activity-live.mjs).
  const from = textFrom(it, threadId);
  /** @type {HTMLElement} */ (box).dataset.from = String(from); // where it starts, for a live step’s paint (activity-paint.mjs)
  const shown = from ? { ...it, text: String(it.text).slice(from) } : it;
  // While it streams, only what follows the blocks it has closed is drawn, and marked (md-stream.mjs, #850).
  if (it.status === 'streaming' && !(it.kind === 'shared' && it.question)) {
    const opts = markdownOpts(shown, threadId);
    for (const n of writeStreaming(box, String(shown.text ?? ''), opts, JSON.stringify([from, opts]))) if (n instanceof Element) markTerms(n, threadId);
  } else {
    forgetStreaming(box);
    writeMarkdown(box, agentMarkdown(shown, threadId));
    markTerms(box, threadId);
  }
  if (it.status === 'streaming') box.append(h('span.caret', { 'aria-hidden': 'true' }));
}

/**
 * Whether a glossary entry can change how an item draws (#564): its text names the term, or links to its key, or the
 * item already shows the key, under the term as it was written before.
 * @param {any} it  @param {{ key: string, term: string }} entry  @param {Element} [node]
 */
export function usesTerm(it, entry, node) {
  if (node?.querySelector(`.term[data-term="${CSS.escape(entry.key)}"]`)) return true;
  const text = `${it.text ?? ''}\n${it.question ?? ''}`.toLowerCase();
  return text.includes(String(entry.term).toLowerCase()) || text.includes(`term:${entry.key}`.toLowerCase());
}
