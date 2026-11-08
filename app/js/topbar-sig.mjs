// What the top bar draws from the state (#986), so main.mjs rebuilds the bar only when one of those changes: any
// conversation’s event used to rebuild it, and fitting the new bar laid out the whole page. topbarSig reads exactly
// what topbar() (shell.mjs) reads for the bar it draws; a part the bar comes to show has to join it here, or the bar
// goes stale (tests/browser/topbar-cost.spec.mjs changes each part in turn).

import { client, needsYou } from './client.mjs';

const S = () => client.state;

/** A conversation’s agents that are here: neither archived nor being deleted. */
export const liveMembers = (t) => t.members.filter((id) => S().sessions[id] && !S().sessions[id].archived && !S().sessions[id].deleting).join(',');

/**
 * What the top bar shows for the view it’s drawn for, as one string.
 * @param {{ title?: string, threadId?: string | null, projectId?: string | null }} view  topbar()’s own arguments
 */
export function topbarSig({ title = '', threadId = null, projectId = null }) {
  const t = threadId ? S().threads[threadId] : null;
  const pid = t?.projectId ?? projectId;
  const parts = [title, t ? liveMembers(t) : '', pid, pid ? S().projects[pid]?.name : '', needsYou().length];
  return JSON.stringify(parts);
}
