// A glossary term’s key: the one spelling its definition is stored and looked up under. Moved out of
// server/ui-tools.mjs, which keys each term define_term adds. Also which spellings are the same term, which the
// glossary matcher (glossary-match.mjs) reads: the key already folds them, since each dash and quote becomes a hyphen.

/**
 * Spellings that differ only in a dash or a quote are one term (#102): “U:45–52” is “U:45-52”, and “Bob’s rule” is
 * “Bob's rule”. Each character a term may use, by the one it folds to: hyphen, non-breaking hyphen, figure dash, en and
 * em dash, and the minus sign; curly single and double quotes.
 */
export const TERM_VARIANTS = { '-': '\u2010\u2011\u2012\u2013\u2014\u2212', "'": '\u2018\u2019', '"': '\u201C\u201D' };

/** Each variant, by the plain character it folds to. */
const PLAIN_OF = new Map(Object.entries(TERM_VARIANTS).flatMap(([plain, variants]) => [...variants].map((v) => [v, plain])));

/** Any one variant, so a term folds in one pass. */
// lint-allow regex: every part is a constant, the variants of TERM_VARIANTS above.
const ANY_VARIANT = new RegExp(`[${Object.values(TERM_VARIANTS).join('')}]`, 'g');

/** A term with each dash and quote folded to its plain one. @param {unknown} term */
export function foldTerm(term) {
  return String(term).replace(ANY_VARIANT, (c) => PLAIN_OF.get(c) ?? c);
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
