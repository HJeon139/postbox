// The undefined-term linter: a pluggable hook that runs on each finished reply. This offline version is
// pattern-based; a model-backed linter can replace lintTerms later with the same signature.
//
// It flags two things the reply never defined in the thread’s glossary:
//   • term links, [label](term:key), whose key has no entry
//   • coined references a reader can’t decode on sight, such as “Step 7”, “R:31” or “§4.2”, unless the person
//     introduced them

import { mapCodeSpans } from '../shared/code-spans.mjs';
import { withoutFences } from '../shared/markdown-plain.mjs';
import { foldTerm, termKey } from '../shared/term-key.mjs';

// The coined references, one pattern each, matched in their own case in a reply (“step 3” in prose is just words):
// a numbered label such as “Step 7” or “Requirement F3”;
const NUMBERED_LABEL = /\b(?:Step|Requirement|Phase|Stage|Rule|Option|Milestone|Scenario)\s+[A-Z]?\d{1,3}[a-z]?\b/;
// a citation by a capital letter and a number or a range, such as “R:31” or “U:45–52” (a time such as “10:30” has no letter);
const CITATION = /\b[A-Z]:\d{1,4}(?:[-\u2010\u2011\u2012\u2013\u2014\u2212]\d{1,4})?\b/;
// a section, such as “§4.2”;
const SECTION = /§\s?\d+(?:\.\d+)*/;
// and a placeholder for something not yet filed or named, such as “sub-issue #A” (not a color such as “#ABC”).
const PLACEHOLDER = /(?<![\w&/])#[A-Z]\b/;
// Left out on purpose, as each would flag more that is fine than it catches (#102): a line number such as “L120”, which
// would flag “L2 cache”; “Table 3”, most often a real label on the page; a bare issue number such as “#208”; and the
// lowercase forms, such as “r:31”, which are mostly something else.
// lint-allow regex: the four patterns just above, each a constant.
const CODED = new RegExp([NUMBERED_LABEL, CITATION, SECTION, PLACEHOLDER].map((re) => re.source).join('|'), 'g');

/**
 * The coined references in some text, by key, in any case: “step 2” in the person’s message is “Step 2”.
 * @param {string} text
 * @returns {Set<string>}
 */
export function numberedTerms(text) {
  return new Set([...String(text ?? '').matchAll(new RegExp(CODED.source, 'gi'))].map((m) => termKey(m[0])));
}

/**
 * @param {string} text           the reply, as Markdown
 * @param {Record<string, { term: string }>} glossary  the thread’s glossary, by key
 * @param {Set<string>} [introduced]  coined references the person introduced (numberedTerms), which need no definition
 * @returns {{ term: string, key: string }[]}
 */
export function lintTerms(text, glossary, introduced = new Set()) {
  // A term is known in any case and with any dash or quote, as the page links it: “U:45-52” is “U:45–52” (#102).
  const sameTerm = (term) => foldTerm(term).toLowerCase();
  const known = new Set(Object.values(glossary).map((g) => sameTerm(g.term)));
  const keys = new Set(Object.keys(glossary));
  const out = new Map();
  // Headings like “### Step 1 · The loop” label the reply’s own structure; they aren’t coined terms.
  const plain = mapCodeSpans(withoutFences(String(text ?? '')), () => ' ').replace(/^ {0,3}#{1,6}\s.*$/gm, ' ');
  for (const m of plain.matchAll(/\[([^\]]+)\]\(term:([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})\)/g)) {
    if (!keys.has(m[2])) out.set(m[2], { term: m[1], key: m[2] });
  }
  for (const m of plain.matchAll(CODED)) {
    const key = termKey(m[0]);
    if (!known.has(sameTerm(m[0])) && !keys.has(key) && !introduced.has(key)) out.set(key, { term: m[0], key });
  }
  return [...out.values()];
}
