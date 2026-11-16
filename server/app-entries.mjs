// What an app sends its agent, as inbox entries (#1425; designs/rooms-at-scale.md, “What an entry is”): Apps’ `send`
// port, which the root binds here. An event the person’s app sends is an `event` entry for the voice line it posted,
// and what the app sent rides in memory with it (Delivery’s `carry`), so it never enters the public inbox. An app check
// that needs a fix is a `check` entry with its problems, which the app’s own state shows already. Functions take the
// Runtime first, as waiting code does until Turns is a service.

/**
 * Sends what an app has for its agent. `itemId` is the voice line an event posted.
 * @param {any} rt @param {string} sessionId @param {any} message @param {{ threadId: string, itemId?: string }} opts
 */
export function sendAppMessage(rt, sessionId, message, { threadId, itemId }) {
  if (message.kind === 'event') return rt.delivery.send({ sessionId, threadId, source: 'event', itemId, from: 'you' }, { carry: message });
  const n = message.problems?.length ?? 0;
  const title = rt.store.state.apps[message.appId]?.title ?? message.appId;
  const text = `${n} problem${n === 1 ? '' : 's'} in your app “${title}”`;
  return rt.delivery.send({ sessionId, threadId, source: 'check', text, message });
}

/**
 * An app’s event whose turn starts after a restart: what the app sent was held in memory and is gone, so the turn
 * reads the voice line it posted, and how to get the rest.
 * @param {any} rt @param {{ threadId: string, itemId?: string }} e
 */
export function lostEvent(rt, e) {
  const voice = String(rt.store.pending.item(e.threadId, e.itemId)?.text ?? '');
  return {
    kind: 'notice',
    text: `The person, through an app: “${voice}”. Postbox restarted before it reached you, so what the app sent with it is gone. Ask the person to send it again if you need it.`,
  };
}
