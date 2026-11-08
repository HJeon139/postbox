// In which permission modes Postbox turns the person’s hooks off in a Claude agent’s turns, and so which mode changes a
// running turn can take (#817, #806). One definition for the ask rules and the overlay (server/adapters/setup.mjs), a
// running Agent SDK turn’s mode change (server/adapters/agent-sdk.mjs, liveControl) and the permissions panel’s words
// (app/js/permission-hooks.mjs), so they can’t drift apart.

/**
 * Whether Postbox adds its own ask rules for writes outside it in this mode (#112), and so turns the person’s hooks
 * off, since a hook that approves a call would skip those rules and the card (#817): Ask me and Accept edits. In Auto
 * (harness first, #961), an unset or unknown mode (which runs as Auto) and Run everything it adds none, and the
 * person’s hooks run, as in their terminal (#806).
 * @param {unknown} mode  a persona’s permissionMode
 */
export const asksForWrites = (mode) => mode === 'ask' || mode === 'acceptEdits';

/**
 * Whether a running turn started in `started` can switch to `mode` now, or keeps its mode until it ends. Its hooks
 * loaded when it started, so a turn that started with them on doesn’t switch into a mode that turns them off: they
 * would keep running, and could approve a call past that mode’s ask rules and card, where the panel says they don’t
 * run. A turn started in bypass keeps bypass too: an Agent SDK turn there has no permission callback and no ask rules.
 * Every other switch takes effect: from a mode with hooks off, or into one that keeps them.
 * @param {unknown} started  the mode the turn started in  @param {unknown} mode  the mode asked for
 */
export function switchesLive(started, mode) {
  if (started === 'bypass') return mode === 'bypass';
  return asksForWrites(started) || !asksForWrites(mode);
}
