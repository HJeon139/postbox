// Where Postbox opens (#320): the conversation you were last in, for `#/`, and per project, for a project’s link. There’s
// no overview, so `#/` and the old `#/archived` come here too. Moved from main.mjs.

import { client, itemsOf, threadsOf } from './client.mjs';
import { h, icon } from './dom.mjs';
import { openSettings } from './sheets.mjs';
import { installLine, topbar } from './shell.mjs';
import { navigate, setAttention } from './ui.mjs';

const usable = (t) => t && !t.archived && !t.deleting && t.kind !== 'side' && t.kind !== 'topic';

// The conversation you were last in, per project, so a project’s tab returns you there, and of all, for `#/`.
export function remember(t) {
  try {
    localStorage.setItem(`pb-last-${t.projectId}`, t.id);
    localStorage.setItem('pb-last', t.id);
  } catch {}
}
/** Where `#/` goes: the conversation you were last in, else the first project with a conversation, else any project. */
function home() {
  let id = null;
  try {
    id = localStorage.getItem('pb-last');
  } catch {}
  const t = id && client.state.threads[id];
  if (usable(t) && client.state.projects[t.projectId]) return `#/t/${t.id}`;
  const projects = Object.values(client.state.projects);
  const p = projects.find((x) => threadsOf(x.id).some((y) => !y.archived)) ?? projects[0];
  return p ? `#/p/${p.id}` : null;
}
export function lastIn(projectId) {
  let id = null;
  try {
    id = localStorage.getItem(`pb-last-${projectId}`);
  } catch {}
  const t = id && client.state.threads[id];
  return usable(t) && t.projectId === projectId ? id : null;
}
export function latestIn(projectId) {
  const at = (t) => itemsOf(t.id).at(-1)?.at ?? t.createdAt ?? 0;
  return threadsOf(projectId)
    .filter((t) => !t.archived)
    .sort((a, b) => at(b) - at(a))[0]?.id;
}

/** Opens where `#/` goes, or with no project at all, says how to add one. */
export function goHome(root) {
  const to = home();
  if (to) {
    navigate(to, { replace: true });
    return;
  }
  // A fresh install has no project yet: this page leads to making one, as the empty overview did.
  const make = h('button.btn', { type: 'button', onclick: () => openSettings('projects') }, icon('plus'), 'New project');
  root.replaceChildren(
    h('div.app.no-rail', topbar({}), h('main.threads-view.empty-home', { id: 'main' }, installLine(), h('p', 'Create a project to start.'), make)),
  );
  setAttention(0, 'Postbox');
}
