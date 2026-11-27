// A glossary term’s key: the one spelling its definition is stored and looked up under. Moved out of
// server/ui-tools.mjs, which keys each term define_term adds.

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
