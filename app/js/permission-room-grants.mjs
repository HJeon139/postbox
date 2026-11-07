// The permissions panel’s “Saved in this room” section (grant once, #852): the rules the person saved with “Allow
// always in this room” on a card, for this agent in this conversation (server/room-grants.mjs), each with Remove.
// Postbox keeps them, never the agent’s folder, and checks every call they pass. A rule’s words go in as text, through h().

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';

/**
 * The section, from permissionsView’s roomGrants; none when the panel wasn’t opened from a conversation.
 * @param {{ persona: { handle: string }, roomGrants?: any[] }} view @param {string | null} sessionId
 * @param {(fn: () => Promise<any>, done: string) => Promise<void>} change  the panel’s, which reloads it
 */
export function roomGrantsSection(view, sessionId, change) {
  if (!sessionId) return null;
  const grants = view.roomGrants ?? [];
  const remove = (g) =>
    change(() => api('/api/permissions/rules', { where: 'room', sessionId, grantId: g.id }), `Removed: ${g.shape} asks you again from the next call.`);
  const rows = grants.map((g) =>
    h(
      'li',
      {},
      h('span.grow', {}, h('code.perm-rule', {}, g.shape), h('span.small.dim', {}, ` for ${g.handle}, saved ${new Date(g.at).toLocaleString()}`)),
      h('button.btn.sm.ghost', { type: 'button', 'aria-label': `Remove ${g.shape}`, onclick: () => remove(g) }, icon('x', 'i-sm'), 'Remove'),
    ),
  );
  return h(
    'section.perm-sec',
    { id: 'perm-room' },
    h('h3.label', {}, 'Saved in this room'),
    rows.length ? h('ul.list-rows', {}, rows) : null,
    h(
      'p.help',
      {},
      rows.length
        ? `Postbox makes these for ${view.persona.handle} with no card, and checks each call: only this project’s repository, never its default branch, and a privacy scan of what a gh call posts.`
        : `None yet. “Allow always in this room” on a card for a git push or gh command saves one for ${view.persona.handle} here.`,
    ),
  );
}
