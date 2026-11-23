// Deleting a project from Settings › Projects (#119): one confirm says what goes and what stays, then it goes at once,
// with every conversation in it, as deleting each would (server/project-delete.mjs). Its folder and files stay.

import { api, client, headerOf, threadsOf } from './client.mjs';
import { h, plural } from './dom.mjs';
import { heard } from './go-when-there.mjs';
import { navigate, openDialog, route, say, toast } from './ui.mjs';

const S = () => client.state;
const LAST = 'This is the only project, and Postbox opens on one. Add another project, then delete this one.';

/**
 * The project row’s Delete project… button. With one project it’s off, still takes focus, and says why, as the Agents
 * header’s − does. @param {any} p  the project @param {() => void} paint  draws the tab again
 */
export function deleteProjectButton(p, paint) {
  const last = Object.keys(S().projects).length < 2;
  return h(
    'button.btn.sm.danger',
    {
      type: 'button',
      'aria-disabled': String(last),
      title: last ? LAST : undefined,
      'aria-description': last ? LAST : undefined,
      onclick: () => {
        if (!last) confirmDeleteProject(p, paint);
      },
    },
    'Delete project…',
  );
}

/** @param {any} p  the project @param {() => void} paint  draws the tab again, after the delete or a failure */
export function confirmDeleteProject(p, paint) {
  const dlg = openDialog({
    title: `Delete the project “${p.name}”?`,
    sub: p.folder,
    role: 'alertdialog',
    body: whatGoes(p),
    foot: [
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h(
        'button.btn.danger',
        {
          type: 'button',
          onclick: () =>
            api(`/api/projects/${p.id}`, null, 'DELETE')
              .then(async () => {
                dlg.close();
                // Once the page has heard it’s gone, so the page under Settings doesn’t open a conversation of it.
                await heard(() => !S().projects[p.id]);
                if (shows(p.id)) navigate('#/');
                paint();
                say(`Deleted the project “${p.name}”`);
              })
              .catch((e) => {
                dlg.close();
                // Some of its conversations may be gone already: the tab shows what’s left.
                paint();
                toast({ title: 'Couldn’t delete the project', text: e.message, level: 'blocking' });
              }),
        },
        'Delete project',
      ),
    ],
    initialFocus: () => null,
  });
  dlg.dialog.querySelector('.d-foot .btn')?.focus();
}

/** Whether the page under Settings shows this project, or a conversation that was in it. @param {string} projectId */
function shows(projectId) {
  const r = route();
  if (r.projectId === projectId) return true;
  return Boolean(r.threadId) && !S().threads[r.threadId];
}

/** What deleting a project erases and what it keeps, as deleting a conversation lists them. @param {any} p */
function whatGoes(p) {
  const conversations = threadsOf(p.id);
  const messages = conversations.reduce((n, t) => n + (headerOf(t.id).count ?? 0), 0);
  const apps = Object.values(S().apps).filter((a) => S().threads[a.threadId]?.projectId === p.id).length;
  const li = (ok, text) =>
    h('li', h(`span.i.i-${ok ? 'check' : 'x'}.i-sm`, { style: { color: ok ? 'var(--good)' : 'var(--alert-ink)' }, 'aria-hidden': 'true' }), h('span', text));
  return [
    h(
      'div.field',
      h('span.label', 'This erases'),
      h(
        'ul.what-goes',
        li(false, `Its ${plural(conversations.length, 'conversation')}, as deleting each would: ${plural(messages, 'message')} and ${plural(apps, 'app')}`),
        li(false, 'The agents’ sessions in them, and their context'),
      ),
    ),
    h('div.field', h('span.label', 'This stays'), h('ul.what-goes', li(true, 'The personas and their other sessions'), li(true, `Files in ${p.folder}`))),
    h('p.small.dim', 'It goes at once. This can’t be undone.'),
  ];
}
