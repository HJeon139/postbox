// What the top bar draws from the state (#986): moved from shell.mjs, so main.mjs can tell when the bar has to change.

import { client } from './client.mjs';

const S = () => client.state;

/** A conversation’s agents that are here: neither archived nor being deleted. */
export const liveMembers = (t) => t.members.filter((id) => S().sessions[id] && !S().sessions[id].archived && !S().sessions[id].deleting).join(',');
