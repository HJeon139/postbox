// Where focus goes when a view in the right pane closes (pane.mjs): to what opens it again. And whether focus is still
// where Reply in thread left it, so the thread it opens may take it (#887).

/**
 * Focus lost with a view that closed goes to what opens it: Work’s button, a thread’s line, else the conversation.
 * Focus given back outside the pane, as to the turn’s list row that opened Work full screen (#195), stays there.
 * Call it only when focus was in the pane before the view closed.
 * @param {{ work: boolean, thread: string | null }} closing  whether Work closed, and the id of the thread that closed
 */
export function refocusClosed(closing) {
  if (document.activeElement && document.activeElement !== document.body) return;
  const button = closing.work ? document.getElementById('work-button') : null;
  const link = closing.thread ? document.querySelector(`#main a[href*="/side/${CSS.escape(closing.thread)}"]`) : null;
  const to = [button, link].find((x) => x instanceof HTMLElement && x.offsetParent);
  /** @type {HTMLElement | null} */ (to ?? document.getElementById('main'))?.focus();
}

/**
 * Whether focus is where Reply in thread left it: on the page, or on the message the thread starts from. Checked by
 * where it is, not by the button: the message may have been drawn again meanwhile.
 * @param {string | undefined} rootItemId  the message the thread starts from
 */
export function focusUntouched(rootItemId) {
  const at = document.activeElement;
  if (!at || at === document.body) return true;
  return !!rootItemId && !!at.closest(`[data-key="${CSS.escape(rootItemId)}"]`);
}
