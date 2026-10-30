// An agent’s text as Markdown (thread.mjs): its citations, @mentions, and glossary terms, marked when they aren’t
// defined yet. A term’s glossary is its thread’s, over the conversation’s it branched from.

import { renderMarkdown } from '/shared/markdown.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { writeMarkdown } from './md-patch.mjs';

const S = () => client.state;
export const handles = () =>
  Object.values(S().personas)
    .filter((p) => !p.retired && !p.deleting)
    .map((p) => p.handle);
const glossaryOf = (threadId) => {
  const t = S().threads[threadId];
  const g = { ...(S().glossary[t?.parentId] ?? {}), ...(S().glossary[threadId] ?? {}) };
  return g;
};

export function agentMarkdown(it, threadId) {
  const answer = renderMarkdown(it.text ?? '', {
    streaming: it.status === 'streaming',
    citations: it.sources?.length ?? 0,
    citeId: `src-${it.id}`,
    glossary: Object.values(glossaryOf(threadId)).map((g) => ({ key: g.key, term: g.term })),
    mentions: handles(),
  });
  // A shared reply’s question (#111) is the person’s own message, drawn as theirs is, and apart from the answer: its
  // Markdown, a fence or a heading, can’t run into the answer’s.
  if (it.kind !== 'shared' || !it.question) return answer;
  return `<div class="shared-q"><span class="shared-q-label">You asked</span>${renderMarkdown(it.question, { mentions: handles() })}</div>${answer}`;
}

export function markTerms(root, threadId) {
  const g = glossaryOf(threadId);
  for (const t of root.querySelectorAll('.term')) {
    const known = !!g[t.dataset.term];
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
  writeMarkdown(box, agentMarkdown(it, threadId));
  markTerms(box, threadId);
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
