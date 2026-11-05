// Keeping a host’s Postbox up to date (#464-b2b; designs/464-keep-updated.md, “What b2b adds”): which state of the
// host’s newest automatic install the page says, from the host’s status (server/remote/host-status.mjs, updateOf).
// The host’s card (hosts-status.mjs) and a turn’s status line (remote.mjs) read it. Nothing here touches the DOM.

/**
 * What the host’s card says of its newest automatic install, or null for nothing:
 * - 'failed': it failed, or Postbox couldn’t read or write its note of installs (update.error), while the host isn’t
 *   connected. Once it’s connected, that’s no longer what needs doing.
 * - 'installed': it installed this version there, connected or not.
 * - 'reinstalled': Postbox wasn’t there any more, so it installed it again with a new token (#464-b3, D4), while the
 *   host is connected; one that isn’t has the link’s own failure to show.
 * - 'installing': it’s under way, while the host isn’t connected.
 * busy and present say nothing: the host connects again by itself, and its status says how that went.
 * @param {any} st  the host’s status, or null before Postbox knows of it
 * @returns {'failed' | 'installed' | 'reinstalled' | 'installing' | null}
 */
export function updateShown(st) {
  const update = st?.update;
  if (!update) return null;
  const connected = st.state === 'connected';
  if (!connected && (update.error || update.outcome === 'failed')) return 'failed';
  if (update.outcome === 'installed') return 'installed';
  if (connected && update.outcome === 'reinstalled') return 'reinstalled';
  if (!connected && update.outcome === 'started') return 'installing';
  return null;
}

/** The version Postbox is installing on the host by itself while the card says so, else null. @param {any} st @returns {string | null} */
export function installingVersion(st) {
  return updateShown(st) === 'installing' ? st.update.version : null;
}
