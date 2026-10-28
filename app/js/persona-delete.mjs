// Deleting a persona from its sheet (#208): what goes and what stays, then 10 seconds to undo, as deleting a session
// or a conversation gives (server/persona-delete.mjs).

import { api, client } from './client.mjs';
import { h, plural } from './dom.mjs';
import { openDialog, toast, undoToast } from './ui.mjs';

const S = () => client.state;
/** Resolves once the page’s state, as the stream keeps it, satisfies `ok`. @param {() => unknown} ok */
const heard = (ok) =>
  new Promise((done) => {
    if (ok()) return done(undefined);
    const off = client.on(() => {
      if (!ok()) return;
      off();
      done(undefined);
    });
  });

/**
 * The sheet’s last two buttons: Retire (or Bring back), and Delete, which asks first.
 * @param {any} p  the persona @param {() => void} back  what the sheet does after Save
 */
export const lifeButtons = (p, back) => [
  h(
    'button.btn',
    { type: 'button', onclick: () => api(`/api/personas/${p.id}`, { retired: !p.retired }, 'PATCH').then(back) },
    p.retired ? 'Bring back' : 'Retire',
  ),
  h('button.btn.danger', { type: 'button', onclick: () => confirmDeletePersona(p, back) }, 'Delete…'),
];

/** @param {any} p  the persona @param {() => void} back  what the sheet does after, as Save and Retire do */
export function confirmDeletePersona(p, back) {
  const dlg = openDialog({
    title: `Delete @${p.handle}?`,
    sub: p.description || undefined,
    role: 'alertdialog',
    body: whatGoes(p),
    foot: [
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h(
        'button.btn.danger',
        {
          type: 'button',
          onclick: () =>
            api(`/api/personas/${p.id}`, null, 'DELETE')
              .then(async (r) => {
                dlg.close();
                // The sheet’s list doesn’t follow the stream, so it waits to hear of the delete, then leaves it out.
                await heard(() => S().personas[p.id]?.deleting);
                back();
                undoToast({
                  text: `Deleted @${p.handle}`,
                  until: r.until,
                  onUndo: () => api(`/api/personas/${p.id}/undo-delete`, {}).catch((e) => toast({ title: 'Too late to undo', text: e.message })),
                });
              })
              .catch((e) => toast({ title: 'Couldn’t delete it', text: e.message, level: 'blocking' })),
        },
        `Delete @${p.handle}`,
      ),
    ],
    initialFocus: () => null,
  });
  dlg.dialog.querySelector('.d-foot .btn')?.focus();
}

/** What deleting a persona erases and what it keeps, as deleting a session lists them. @param {any} p */
function whatGoes(p) {
  const sessions = Object.values(S().sessions).filter((se) => se.personaId === p.id && !se.deleting);
  const li = (ok, text) =>
    h('li', h(`span.i.i-${ok ? 'check' : 'x'}.i-sm`, { style: { color: ok ? 'var(--good)' : 'var(--alert-ink)' }, 'aria-hidden': 'true' }), h('span', text));
  return [
    h(
      'div.field',
      h('span.label', 'This erases'),
      h(
        'ul.what-goes',
        li(false, `@${p.handle}, its instructions and its settings`),
        li(false, `Its ${plural(sessions.length, 'session')}, as deleting each would: a conversation it’s alone in goes with it`),
        li(false, 'What it remembered: its own memory, in every project'),
      ),
    ),
    h(
      'div.field',
      h('span.label', 'This stays'),
      h(
        'ul.what-goes',
        li(true, 'Other agents, and their memory'),
        li(true, 'Files in the project folders'),
        p.remote?.hostId ? li(true, 'Its memory on the host it runs on: Postbox can’t remove a host’s files yet') : null,
      ),
    ),
    h('p.small.dim', 'You’ll have 10 seconds to undo. A new agent with the same name starts with no memory.'),
  ];
}
