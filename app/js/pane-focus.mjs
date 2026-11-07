// Where focus goes when a view in the right pane closes (pane.mjs): to what opens it again.

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
