// Each agent’s state, read from the room’s records and never stored, and never from what an agent said in chat
// (designs/rooms-at-scale.md, “Live state”; designs/architecture/services.md, “Agent state”). The page reads it from
// public state alone: the session (with its bounded list of background jobs) and the inboxes (Delivery’s entries).
// Never the conversation’s work list, which grows with the room: a row paints on every session event (#1155’s targets).
//
// One state at a time, the first that holds:
// - you: it waits on the person. Today that is the session’s needs-you state; Asks makes it its open asks;
// - stopping: the person pressed Stop and its turn hasn’t ended yet, so they see the Stop took;
// - running: a live turn, or one on its host, awaiting attach among them, with its current step;
// - quota: its harness ran out of quota, until the reset time it gave (the owner’s decision on #442). The one place
//   quota shows in the agents area, and never as needs-you. Turns marks every agent on the backend when a turn fails
//   for quota, so only the person’s message starts one before the reset, and a session running again is past it
//   (server/turn-quota.mjs);
// - failed: its last turn failed;
// - job: a background job of its own still runs (`se.jobs`, at most 50, and a kept one stays until it ends);
// - behind: something it posted still waits in another agent’s inbox, since that entry arrived;
// - idle.

import { conversationRoot } from './conversation.mjs';

/** Session states of a live turn. */
const LIVE = new Set(['think', 'gen', 'tool']);
/** Remote-turn states in which the turn is still on its host (app/js/remote.mjs, ON_HOST), awaiting attach among them. */
const ON_HOST = new Set(['running', 'waiting', 'lost', 'stopping']);

/**
 * @typedef {{ state: 'you'|'stopping'|'running'|'quota'|'failed'|'job'|'behind'|'idle', detail: string, since?: number, until?: number }} AgentState
 * until is the quota’s reset time, when the harness gave one; since is when the oldest entry arrived, for behind.
 * detail is the step for running, the job’s label for job, and the other agent’s handle for behind.
 */

/**
 * @param {any} se the agent’s session
 * @param {{ threads?: any, sessions?: any, inbox?: any }} s the room’s public state
 * @param {number} [now] the time to compare a quota’s reset time with
 * @returns {AgentState}
 */
export function agentState(se, s, now = Date.now()) {
  if (!se) return { state: 'idle', detail: '' };
  if (se.state === 'needs') return { state: 'you', detail: '' };
  if (se.state === 'stopping') return { state: 'stopping', detail: '' };
  if (LIVE.has(se.state) || ON_HOST.has(se.remoteTurn?.state)) return { state: 'running', detail: se.currentStep ?? '' };
  const until = se.quota?.until;
  if (quotaOut(se, now)) return { state: 'quota', detail: '', ...(until ? { until } : {}) };
  if (se.state === 'failed') return { state: 'failed', detail: '' };
  const job = jobOf(se);
  if (job) return { state: 'job', detail: job };
  const conv = conversationRoot(s.threads, se.threadId);
  const behind = conv && behindOf(se, conv, s);
  if (behind) return { state: 'behind', detail: behind.handle, since: behind.at };
  return { state: 'idle', detail: '' };
}

/**
 * Whether the agent is out of quota now: marked, and its reset, if the harness gave one, not past (#442).
 * @param {any} se @param {number} [now]
 */
export const quotaOut = (se, now = Date.now()) => Boolean(se?.quota) && (se.quota.until == null || se.quota.until > now);

/** The label of the agent’s newest background job still running, from its session’s bounded list. */
function jobOf(se) {
  const jobs = Array.isArray(se.jobs) ? se.jobs : [];
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].state === 'running') return jobs[i].label ?? 'Background job';
  return null;
}

/**
 * The other agent in the conversation whose inbox holds the agent’s oldest post still waiting, with when it arrived.
 * Delivery’s sender view (services.md, `stateOf`): “waiting behind @x since”. It walks the inboxes, which the page holds
 * only the entries of it can act on (shared/inbox-page.mjs), and checks an inbox’s conversation only for a post of the
 * agent’s, not every session in the room.
 */
function behindOf(se, conv, s) {
  /** @type {{ handle: string, at: number } | null} */
  let oldest = null;
  for (const [id, list] of Object.entries(s.inbox ?? {})) {
    if (id === se.id) continue;
    for (const e of list) {
      if (e.from !== se.handle || e.state !== 'waiting' || (oldest && e.at >= oldest.at)) continue;
      const other = s.sessions?.[id];
      if (other && conversationRoot(s.threads, other.threadId) === conv) oldest = { handle: other.handle, at: e.at };
    }
  }
  return oldest;
}
