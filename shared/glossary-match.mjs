// Glossary matching: which words of a reply link to which glossary term. Moved out of shared/markdown-inline.mjs,
// whose text runs call it on text already escaped there.

import { escapeHtml } from './markdown-inline.mjs';
import { escapeRegExp } from './regex.mjs';
import { foldTerm, TERM_VARIANTS } from './term-key.mjs';

// A term this short, such as “R” or “U”, is most often a letter of something else: “R&D”, “U.S.”, “see u later”.
// It links only in its own case, and not beside & or a dotted letter (#102). A longer term links in any case.
const SHORT = 2;
const WHOLE_WORD_BEFORE = '(?<![\\w-])';
const WHOLE_WORD_AFTER = '(?![\\w-])';
// The text is escaped, so & reads as &amp;. Spaced, as in “R & D”, the letters stay words of their own.
const SHORT_BEFORE = '(?<![\\w-]|&amp;|[A-Za-z]\\.)';
const SHORT_AFTER = '(?![\\w-]|&amp;|\\.[A-Za-z])';

/**
 * The form two spellings of one term share, from text escaped as the reply’s is: its quotes unescaped, then each dash
 * and quote folded to its plain one (term-key.mjs, foldTerm).
 * @param {string} escaped
 */
const sameForm = (escaped) => foldTerm(escaped.replaceAll('&#39;', "'").replaceAll('&quot;', '"'));

/** One character’s pattern: a plain dash or quote matches its variants too, and its escaped form as the reply has it. */
function charPattern(c) {
  if (!Object.hasOwn(TERM_VARIANTS, c)) return escapeRegExp(c);
  return `(?:${escapeRegExp(escapeHtml(c))}|[${TERM_VARIANTS[c]}])`;
}

/** A term’s pattern, from its same form, one character at a time. */
const termPattern = (form) => [...form].map(charPattern).join('');

/** The terms’ patterns as one alternation, longest first, so “Phase 1 review” wins over “Phase 1”. */
function alternation(forms) {
  return [...forms]
    .sort((a, b) => b.length - a.length)
    .map(termPattern)
    .join('|');
}

/**
 * The matcher for a glossary: `re` finds candidates in escaped text, and `keyOf` gives a candidate’s key, or nothing
 * when the candidate is a short term in another case, which then stays text.
 * @param {{ term?: string, key?: string }[] | null | undefined} glossary
 * @returns {{ re: RegExp, keyOf: (match: string) => string | undefined } | null}
 */
export function glossaryRegex(glossary) {
  const entries = (glossary ?? []).filter((g) => g?.term && g?.key);
  if (!entries.length) return null;
  const isShort = (g) => [...g.term].length <= SHORT;
  const exact = new Map(entries.filter(isShort).map((g) => [sameForm(escapeHtml(g.term)), g.key]));
  const anyCase = new Map(entries.filter((g) => !isShort(g)).map((g) => [sameForm(escapeHtml(g.term)).toLowerCase(), g.key]));
  const branches = [];
  if (anyCase.size) branches.push(`${WHOLE_WORD_BEFORE}(?:${alternation(anyCase.keys())})${WHOLE_WORD_AFTER}`);
  if (exact.size) branches.push(`${SHORT_BEFORE}(?:${alternation(exact.keys())})${SHORT_AFTER}`);
  // The pattern is case-insensitive for the longer terms; keyOf holds the short ones to their own case.
  // lint-allow regex: glossary terms, each escaped by escapeRegExp in termPattern.
  const re = new RegExp(branches.join('|'), 'gi');
  const keyOf = (match) => {
    const form = sameForm(match);
    return exact.get(form) ?? anyCase.get(form.toLowerCase());
  };
  return { re, keyOf };
}
