// In which permission modes Postbox turns the person’s hooks off in a Claude agent’s turns (#817, #806). One definition
// for the ask rules and the overlay (server/adapters/setup.mjs) and the permissions panel’s words
// (app/js/permission-hooks.mjs), so they can’t drift apart.

/**
 * Whether Postbox adds its own ask rules for writes outside it in this mode (#112), and so turns the person’s hooks
 * off, since a hook that approves a call would skip those rules and the card (#817): Ask me and Accept edits. In Auto
 * (harness first, #961), an unset or unknown mode (which runs as Auto) and Run everything it adds none, and the
 * person’s hooks run, as in their terminal (#806).
 * @param {unknown} mode  a persona’s permissionMode
 */
export const asksForWrites = (mode) => mode === 'ask' || mode === 'acceptEdits';
