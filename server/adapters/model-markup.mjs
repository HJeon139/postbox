// A model’s own tool-call markup, left in the text a backend streams as the reply (#1916). On deepseek-3.2, Kiro’s
// message chunks end with `<｜DSML｜function_calls` where the model then called a tool (recorded in
// tests/fixtures/kiro-cli/tool-load-deepseek.jsonl, kiro-cli 3.6.2), and the person saw it in the reply. Kiro streams
// other models in token-sized chunks (mcp-failed.jsonl), so the marker can come split across them (#1934):
// markupHolder holds back what could still become one, and drops it if it’s whole where the message ends. Words that
// mention it elsewhere, in code or a sentence, stay.

/**
 * What could still become the marker at the end of the text so far: any start of it, with the space before it, or a
 * line break and space alone, as come before the marker where the whole-chunk rule drops them (#1916). Space with no
 * line break isn’t held, so ordinary tokens reach the reply when they did.
 */
const MAYBE_MARKER = /(?:\s*(?<!`)<(?:｜(?:D(?:S(?:M(?:L(?:｜[A-Za-z_]*>?\s*)?)?)?)?)?)?|[^\S\n]*\n\s*)?$/u;

/** A whole marker and nothing else, with the space before it. */
const WHOLE_MARKER = /^\s*<｜DSML｜[A-Za-z_]+>?\s*$/u;

/**
 * For a stream of message chunks: shows each through `emit` as reply text, holding back an end that could still become
 * DeepSeek’s marker (#1934). The next chunk decides, as more of the same text; at a boundary (a tool call, a thought,
 * the turn’s end), a whole marker is dropped and anything else is let go as the words it was.
 * @param {(e: { kind: 'text', text: string }) => void} emit
 */
export function markupHolder(emit) {
  let held = '';
  const say = (/** @type {string} */ text) => {
    if (text) emit({ kind: 'text', text });
  };
  return {
    /** A message chunk’s words. @param {string} text */
    chunk(text) {
      const all = held + text;
      const maybe = /** @type {RegExpExecArray} */ (MAYBE_MARKER.exec(all));
      held = maybe[0];
      say(all.slice(0, maybe.index));
    },
    /** At a boundary: what was held, as words, unless it was a whole marker. */
    letGo() {
      const rest = held;
      held = '';
      if (!WHOLE_MARKER.test(rest)) say(rest);
    },
  };
}
