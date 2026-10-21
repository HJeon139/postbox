// The undefined-term linter: a pluggable hook that runs on each finished reply. This offline version is
// pattern-based; a model-backed linter can replace lintTerms later with the same signature.
//
// It flags two things the reply never defined in the thread’s glossary:
//   • term links, [label](term:key), whose key has no entry
//   • numbered coined references such as “Step 7” or “Requirement F3”

const NUMBERED = /\b(?:Step|Requirement|Phase|Stage|Rule|Option|Milestone|Scenario)\s+[A-Z]?\d{1,3}[a-z]?\b/g;

/**
 * @param {string} text           the reply, as Markdown
 * @param {Record<string, { term: string }>} glossary  the thread’s glossary, by key
 * @returns {{ term: string, key: string }[]}
 */
export function lintTerms(text, glossary) {
  const known = new Set(Object.values(glossary).map((g) => g.term.toLowerCase()));
  const keys = new Set(Object.keys(glossary));
  const out = new Map();
  // Headings like “### Step 1 · The loop” label the reply’s own structure; they aren’t coined terms.
  const plain = String(text ?? '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`]*`/g, ' ').replace(/^ {0,3}#{1,6}\s.*$/gm, ' ');
  for (const m of plain.matchAll(/\[([^\]]+)\]\(term:([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})\)/g)) {
    if (!keys.has(m[2])) out.set(m[2], { term: m[1], key: m[2] });
  }
  for (const m of plain.matchAll(NUMBERED)) {
    const key = m[0].toLowerCase().replace(/\s+/g, '-');
    if (!known.has(m[0].toLowerCase()) && !keys.has(key)) out.set(key, { term: m[0], key });
  }
  return [...out.values()];
}
