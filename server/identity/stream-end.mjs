// A hosted Postbox’s event stream ends when the sign-in it opened with does (designs/architecture/hosted.md, “A stream
// outlives nothing”). The stream is checked as it opens and then lives as long as the page, so without this a person
// removed at the identity provider or from the allow list, or a token someone copied, would go on receiving every
// event. The page reconnects by itself, with a fresh token that is checked again.

/**
 * Ends the request’s connection at `until`, unless it has closed by then.
 * @param {import('node:http').IncomingMessage} req @param {number} until  when the token stops being good, in ms since 1970
 * @param {{ now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [clock]  tests pass fakes
 */
export function endAt(req, until, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const timer = setTimer(() => req.destroy(), Math.max(0, until - now()));
  timer.unref?.(); // a stream waiting to end keeps no process alive
  req.once('close', () => clearTimer(timer));
}
