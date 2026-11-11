// The open view’s top bar, kept current as the state changes (#986): rebuilt only when what it shows changes, and the
// whole view when the conversation’s agents do. main.mjs calls it from its live updates.

import { client } from './client.mjs';
import { holdFocus } from './rerender-state.mjs';
import { threadTopbar } from './search-dialog.mjs';
import { topbar } from './shell.mjs';
import { liveMembers, topbarSig } from './topbar-sig.mjs';
import { refind } from './ui.mjs';

const topSig = new Map();
export function topbarChanged(se) {
  const sig = `${se.needs?.kind}|${se.archived}`;
  const changed = topSig.get(se.id) !== sig;
  topSig.set(se.id, sig);
  return changed;
}
/** What the top bar is drawn from in the open view: topbar()’s arguments. @param {any} current  the open route */
function barView(current) {
  if (current.view === 'thread') return { title: client.state.threads[current.threadId]?.title, threadId: current.threadId };
  if (current.projectId) return { title: current.view === 'threads' ? 'Threads' : '', projectId: current.projectId };
  return {};
}
/**
 * Rebuilds the open view’s top bar when what it shows changed, or the whole view when the conversation’s agents did.
 * @param {{ root: HTMLElement, current: any, render: (o: { rebuild: boolean }) => void }} view  main.mjs’s root, its open route and its render
 */
export function refreshTop({ root, current, render }) {
  const old = root.querySelector('header.topbar');
  if (!old || !current) return;
  // Only a change to what the bar shows rebuilds it: another conversation’s event costs a compare, not a layout (#986).
  if (old.dataset.sig === topbarSig(barView(current))) return;
  let next;
  if (current.view === 'thread') {
    const t = client.state.threads[current.threadId];
    if (!t) return;
    // Members changed (an agent joined or left): rebuild the whole view, with the keyboard where it was (#739).
    if (old.dataset.members !== liveMembers(t)) {
      const back = holdFocus();
      render({ rebuild: true });
      back();
      return;
    }
    next = threadTopbar(t);
  } else if (current.projectId) next = topbar({ title: current.view === 'threads' ? 'Threads' : '', projectId: current.projectId });
  else next = topbar({});
  // The keyboard stays where it was: focus on a control of the old bar moves to the same control in the new one.
  // A rename’s dialog can close before its change arrives, and return focus to the bar this replaces (#26).
  const back = document.activeElement && old.contains(document.activeElement) ? refind(document.activeElement) : null;
  old.replaceWith(next);
  back?.()?.focus();
}
