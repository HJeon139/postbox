// The hosts a remote turn needs (#120, server/remote/turns.mjs): Postbox needs a host while a turn runs on it, is
// being attached again, or waits for a stop there, so its link connects and is listened to. What the link says goes
// to the RemoteTurns’ onHostMessage and onConnected (server/remote/turns-messages.mjs).

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/** Postbox needs a host while a turn runs on it, or one is being attached: its link connects and is listened to. @param {RemoteTurns} rts @param {string} hostId */
export function needHost(rts, hostId) {
  if (!rts.hosts) return;
  const h = rts.needed.get(hostId);
  if (h) {
    h.refs++;
    listen(rts, hostId);
    return;
  }
  rts.needed.set(hostId, { refs: 1, link: null, off: () => {} });
  try {
    rts.hosts.need(hostId, 'turn');
  } catch (e) {
    // Postbox is closing its links: the turn’s prepare finds out, and says so.
    console.error(`Postbox couldn’t keep a host connected for a turn: ${e.message}`);
  }
  listen(rts, hostId);
}

/**
 * Listens to the link the manager has for the host now. A host that isn’t installed (or was removed) has none yet:
 * the turn’s prepare says why. One installed since, or again with another token, has a new link, listened to from
 * the next turn’s prepare.
 * @param {RemoteTurns} rts @param {string} hostId
 */
export function listen(rts, hostId) {
  const h = rts.needed.get(hostId);
  if (!h) return null;
  /** @type {any} */
  let link = null;
  try {
    link = rts.hosts?.link(hostId) ?? null;
  } catch (e) {
    // Renamed while turns run over the old link: they’re still heard on it, and nothing new gets it.
    if (e?.code === 'host-renamed-busy') return null;
    link = null;
  }
  if (link === h.link) return link;
  h.off();
  const onMessage = (/** @type {any} */ m) => rts.onHostMessage(hostId, m);
  const onConnected = (/** @type {any} */ w) => rts.onConnected(hostId, w);
  link?.on?.('message', onMessage);
  link?.on?.('connected', onConnected);
  h.link = link;
  h.off = () => {
    link?.off?.('message', onMessage);
    link?.off?.('connected', onConnected);
  };
  return link;
}

/** @param {RemoteTurns} rts @param {string} hostId */
export function releaseHost(rts, hostId) {
  const h = rts.needed.get(hostId);
  if (!h || --h.refs > 0) return;
  h.off();
  rts.needed.delete(hostId);
  rts.hosts?.release(hostId, 'turn');
}

/** Why the manager may have no link to give: it’s closing its links (Postbox shuts down), or the host isn’t installed or is gone. */
const NO_LINK = new Set(['closed', 'not-installed', 'no-host', 'host-renamed-busy']);

/**
 * The host’s link, to send on, or null when the manager has none to give (NO_LINK). A send over null is false, so
 * nothing throws out of an answer or a reply as Postbox shuts down: an answer stays on its card, and goes when the
 * daemon, which keeps the prompt, sends it again after the next start’s hello (turns-prompts.mjs, onPrompt).
 * @param {RemoteTurns} rts @param {string} hostId
 */
export function linkOf(rts, hostId) {
  const held = rts.needed.get(hostId)?.link;
  if (held) return held;
  try {
    return rts.hosts?.link(hostId) ?? null;
  } catch (e) {
    if (NO_LINK.has(e?.code)) return null;
    throw e;
  }
}
