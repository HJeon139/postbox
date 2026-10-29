// The reply text a Claude turn has written, so a result whose text no event carried can still be posted (#485). A
// recorded stream (tests/fixtures/claude-code/background-moved.jsonl, cut) has replies only in `result.result`, and a
// reply Postbox never shows reaches no one.

/** Text with its runs of whitespace as one space, to compare streamed text with a result’s. @param {string} s */
const squash = (s) => s.split(/\s+/).filter(Boolean).join(' ');

/**
 * What the stream mapper writes reply text through. write: a piece of reply text, kept (its last 200,000 characters).
 * whole: a text block that arrived whole, after a paragraph break if text came before it this turn.
 * fromResult: a result’s text, posted when it isn’t what was written. Its first words are enough to know it, since a
 * recording can differ later in the text (local paths scrubbed apart), and a reply posted twice is worse than one
 * missed here, which the runtime’s empty-reply guard still catches.
 * @param {{ text: (t: string) => void }} ctx @param {{ wroteText: boolean }} st  the mapper’s state
 */
export function replyText(ctx, st) {
  let written = '';
  const write = (/** @type {string} */ t) => {
    ctx.text(t);
    written = (written + t).slice(-200_000);
    st.wroteText = true;
  };
  const whole = (/** @type {string} */ t) => {
    if (st.wroteText) ctx.text('\n\n');
    write(t);
  };
  return {
    write,
    whole,
    /** Posts a result’s text if it’s new, and returns the result. @param {any} e  a result event */
    fromResult(e) {
      const said = !e.is_error && typeof e.result === 'string' ? e.result.trim() : '';
      if (said && !squash(written).includes(squash(said).slice(0, 60))) whole(said);
      return e;
    },
  };
}
