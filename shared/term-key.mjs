// A glossary term’s key: the one spelling its definition is stored and looked up under. Moved out of
// server/ui-tools.mjs, which keys each term define_term adds. Also which spellings are the same term, which the
// glossary matcher (glossary-match.mjs) reads: the key already folds them, since each dash and quote becomes a hyphen.

/**
 * Spellings that differ only in a dash or a quote are one term (#102): “U:45–52” is “U:45-52”, and “Bob’s rule” is
 * “Bob's rule”. Each character a term may use, by the one it folds to: hyphen, non-breaking hyphen, en and em dash;
 * curly single and double quotes.
 */
export const TERM_VARIANTS = { '-': '\u2010\u2011\u2013\u2014', "'": '\u2018\u2019', '"': '\u201C\u201D' };

/** Each variant, by the plain character it folds to. */
const PLAIN_OF = new Map(Object.entries(TERM_VARIANTS).flatMap(([plain, variants]) => [...variants].map((v) => [v, plain])));

/** A term with each dash and quote folded to its plain one. @param {unknown} term */
export function foldTerm(term) {
  return [...String(term)].map((c) => PLAIN_OF.get(c) ?? c).join('');
}

/**
 * The key for a term, or for the key an agent gave it: lowercase letters and digits, with each run of anything else
 * as one hyphen, up to 64 characters.
 * @param {unknown} term
 */
export function termKey(term) {
  return (
    String(term)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'term'
  );
}
