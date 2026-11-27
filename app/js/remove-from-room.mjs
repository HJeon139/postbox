// Removing an agent from a room (#1743): it stops taking part there, from now on. What it already said stays as it was
// said, under its name, and the agent itself, its settings and its other rooms are untouched. Its session in the room
// ends, so if it’s added back it starts a new one and reads the room again. The confirm says that, in words that can’t be
// mistaken for deleting the agent (persona-delete.mjs), which takes it from every room.

import { api, client } from './client.mjs';
import { h, plural } from './dom.mjs';
import { openDialog, say, toast } from './ui.mjs';

const S = () => client.state;

/**
 * Asks to remove an agent’s session from a room, then removes it, through the route that refuses rather than erase the
 * room if this is its last agent by the time the person confirms (#1620). removed runs once it’s done.
 * @param {any} se @param {{ removed?: () => void }} [opts]
 */
export function confirmRemove(se, { removed } = {}) {
  const t = S().threads[se.threadId];
  const room = t?.title ?? 'this room';
  const apps = Object.values(S().apps).filter((a) => a.sessionId === se.id).length;
  const li = (ok, text) =>
    h('li', h(`span.i.i-${ok ? 'check' : 'x'}.i-sm`, { style: { color: ok ? 'var(--good)' : 'var(--alert-ink)' }, 'aria-hidden': 'true' }), h('span', text));
  const dlg = openDialog({
    title: `Remove ${se.handle} from ${room}?`,
    sub: S().projects[t?.projectId]?.name,
    role: 'alertdialog',
    body: [
      h(
        'div.field',
        h('span.label', 'This ends'),
        h(
          'ul.what-goes',
          li(false, `${se.handle}’s part in this room, from now on`),
          li(false, 'Its session here. Added back, it starts a new one and reads the room again'),
        ),
      ),
      h(
        'div.field',
        h('span.label', 'This stays'),
        h(
          'ul.what-goes',
          li(true, 'Its messages here, as they were said'),
          apps ? li(true, `The ${plural(apps, 'app')} it wrote here`) : null,
          li(true, `${se.handle} itself, its settings and its other rooms`),
          li(true, `Files in ${S().projects[t?.projectId]?.folder ?? 'the project folder'}`),
        ),
      ),
    ],
    foot: [
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h(
        'button.btn.danger',
        {
          type: 'button',
          onclick: async () => {
            dlg.close();
            try {
              // Always the remove that keeps the room: if the agent is the last one by now, it’s refused, not the room erased.
              await api(`/api/sessions/${se.id}/remove`, {});
              say(`Removed ${se.handle} from ${room}`);
              removed?.();
            } catch (e) {
              toast({ title: `Couldn’t remove @${se.handle}`, text: e.message, level: 'blocking' });
            }
          },
        },
        `Remove ${se.handle}`,
      ),
    ],
  });
}
