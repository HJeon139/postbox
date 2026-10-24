// An agent’s text as Markdown (thread.mjs): its citations, @mentions, and glossary terms, marked when they aren’t
// defined yet. A term’s glossary is its thread’s, over the conversation’s it branched from.

import { renderMarkdown } from '/shared/markdown.mjs';
import { client } from './client.mjs';

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
  const text = it.kind === 'shared' && it.question ? `**You asked:** “${it.question}”\n\n${it.text ?? ''}` : (it.text ?? '');
  return renderMarkdown(text, {
    streaming: it.status === 'streaming',
    citations: it.sources?.length ?? 0,
    citeId: `src-${it.id}`,
    glossary: Object.values(glossaryOf(threadId)).map((g) => ({ key: g.key, term: g.term })),
    mentions: handles(),
  });
}

export function markTerms(root, threadId) {
  const g = glossaryOf(threadId);
  for (const t of root.querySelectorAll('.term')) {
    const known = !!g[t.dataset.term];
    t.classList.toggle('undef', !known);
    if (!known) t.title = 'Not defined yet. The agent has been asked to define it.';
  }
}
