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
// Each & in the escaped text starts an entity, such as &amp;, &lt; or &#39;. A term such as “AMP”, “lt” or “39” never
// starts right after one, so the entity stays whole (#102). Further in, the whole-word guards keep it out.
const NOT_IN_ENTITY = '(?<!&|&#)';

/**
 * The form two spellings of one term share, from text escaped as the reply’s is: its quotes unescaped, then each dash
 * and quote folded to its plain one (term-key.mjs, foldTerm).
 * @param {string} escaped
 */
const sameForm = (escaped) => foldTerm(escaped.replaceAll('&#39;', "'").replaceAll('&quot;', '"'));

/**
 * A term’s pattern, from its same form: each plain dash or quote matches its variants too, and its escaped form as the
 * reply has it. escapeRegExp leaves the three alone, so one pass over the escaped form places them.
 * @param {string} form
 */
const termPattern = (form) => escapeRegExp(form).replace(/[-'"]/g, (c) => `(?:${escapeHtml(c)}|[${TERM_VARIANTS[c]}])`);

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
  const entries = /** @type {{ term: string, key: string }[]} */ ((glossary ?? []).filter((g) => g?.term && g?.key));
  if (!entries.length) return null;
  const sig = entries.map((g) => `${g.key}\u0000${g.term}`).join('\u0001');
  if (sig !== last.sig) last = { sig, made: buildMatcher(entries) };
  return last.made;
}

// The last glossary’s matcher, by its terms and keys: each reply in a room renders with the same glossary, so it is
// built once, not once per reply. Sharing its global regex is safe: String.prototype.replace resets lastIndex.
/** @type {{ sig: string, made: { re: RegExp, keyOf: (match: string) => string | undefined } | null }} */
let last = { sig: '', made: null };

/** @param {{ term: string, key: string }[]} entries */
function buildMatcher(entries) {
  const isShort = (g) => [...g.term].length <= SHORT;
  const exact = new Map(entries.filter(isShort).map((g) => [sameForm(escapeHtml(g.term)), g.key]));
  const anyCase = new Map(entries.filter((g) => !isShort(g)).map((g) => [sameForm(escapeHtml(g.term)).toLowerCase(), g.key]));
  const branches = [];
  if (anyCase.size) branches.push(`${NOT_IN_ENTITY}${WHOLE_WORD_BEFORE}(?:${alternation(anyCase.keys())})${WHOLE_WORD_AFTER}`);
  if (exact.size) branches.push(`${NOT_IN_ENTITY}${SHORT_BEFORE}(?:${alternation(exact.keys())})${SHORT_AFTER}`);
  // The pattern is case-insensitive for the longer terms; keyOf holds the short ones to their own case.
  // lint-allow regex: glossary terms, each escaped by escapeRegExp in termPattern.
  const re = new RegExp(branches.join('|'), 'gi');
  const keyOf = (match) => {
    const form = sameForm(match);
    return exact.get(form) ?? anyCase.get(form.toLowerCase());
  };
  return { re, keyOf };
}
