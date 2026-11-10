// An app’s sends, one after another (#934), so the server stores them in the order the app sent them.

/** Each app’s last send, so the next starts once it has an answer (#934). @type {Map<string, Promise<unknown>>} */
const sendChains = new Map();
/** How long one send holds back the next: a send with no answer by then keeps waiting for it, but the rest go on. */
export const SEND_TURN_MS = 5000;
/**
 * Runs an app’s send after the one before it has an answer, failed or not, or has run for its turn of SEND_TURN_MS, so
 * one that fails or never answers holds back none after it for long. It isn’t canceled: its own answer, or failure,
 * still reaches the app. O(1) per send: one promise kept per app. @param {string} appId @param {() => Promise<any>} send
 */
export function inOrder(appId, send) {
  const before = sendChains.get(appId) ?? Promise.resolve();
  const run = before.then(send);
  // The turn starts when this send does, once the one before is through, not when it was queued.
  const turn = before.then(() => new Promise((done) => setTimeout(done, SEND_TURN_MS)));
  sendChains.set(appId, Promise.race([run.catch(() => {}), turn]));
  return run;
}
