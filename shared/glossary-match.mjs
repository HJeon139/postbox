// Glossary matching: which words of a reply link to which glossary term. Moved out of shared/markdown-inline.mjs,
// whose text runs call it on text already escaped there.

import { escapeHtml } from './markdown-inline.mjs';

export function glossaryRegex(glossary) {
  const entries = (glossary ?? []).filter((g) => g?.term && g?.key);
  if (!entries.length) return null;
  const keys = new Map(entries.map((g) => [escapeHtml(g.term).toLowerCase(), g.key]));
  const alts = [...keys.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // lint-allow regex: glossary terms, each escaped just above.
  return { re: new RegExp(`(?<![\\w-])(?:${alts.join('|')})(?![\\w-])`, 'gi'), keys };
}
