// Where Postbox opens (#320): the conversation you were last in, for `#/`, and per project, for a project’s link. There’s
// no overview, so `#/` and the old `#/archived` come here too. Moved from main.mjs.

import { client, headerOf, sessionsOf, threadsOf } from './client.mjs';
import { h, icon } from './dom.mjs';
import { openSettings } from './sheets.mjs';
import { installLine, topbar } from './shell.mjs';
import { navigate, setAttention } from './ui.mjs';

// Conversations you’ve just deleted the last agent of, which go with it (#320): skipped at once, before the page hears
// that the session is being deleted.
const gone = new Set();
const usable = (t) => t && !gone.has(t.id) && t.kind !== 'side' && t.kind !== 'topic' && sessionsOf(t.id).length > 0;

/** Leaves a conversation whose last agent is being deleted, for where `#/` goes, and never opens it again. */
export function leave(threadId) {
  gone.add(threadId);
  navigate('#/');
}

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
  const p = projects.find((x) => threadsOf(x.id).some(usable)) ?? projects[0];
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
  const at = (t) => headerOf(t.id).lastAt ?? t.createdAt ?? 0;
  return threadsOf(projectId)
    .filter(usable)
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
  // The same id as the new project’s New conversation, so closing Settings once the project opens puts focus there (#549).
  const make = h('button.btn', { type: 'button', id: 'first-step', onclick: () => openSettings('projects') }, icon('plus'), 'New project');
  const page = h('main.threads-view.empty-home', { id: 'main' }, installLine(), h('p', 'Create a project to start.'), make);
  root.replaceChildren(h('div.app.no-rail', topbar({}), page));
  setAttention(0, 'Postbox');
  // The first project, made from this page’s New project, opens as a reload would (#549). Stops once the page goes.
  const off = client.on(() => {
    if (!page.isConnected) return off();
    const next = home();
    if (!next) return;
    off();
    // Focus on this page, as when Settings closed before the project came: to the new page’s first step, once drawn.
    if (page.contains(document.activeElement)) addEventListener('hashchange', () => document.getElementById('first-step')?.focus(), { once: true });
    navigate(next, { replace: true });
  });
}
