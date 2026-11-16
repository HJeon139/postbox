// Each agent’s state, read from the room’s records and never stored, and never from what an agent said in chat
// (designs/rooms-at-scale.md, “Live state”; designs/architecture/services.md, “Agent state”). The page reads it from
// public state alone: the session, the conversation’s work (its jobs) and the inboxes (Delivery’s entries).
//
// One state at a time, the first that holds:
// - failed: its last turn failed;
// - you: it waits on the person. Today that is the session’s needs-you state; Asks makes it its open asks;
// - running: a live turn, one stopping, or one on its host, with its current step;
// - job: a command it started in the background still runs;
// - behind: something it posted still waits in another agent’s inbox, since that entry arrived;
// - idle.

import { conversationRoot } from './conversation.mjs';

/** Session states of a live turn, and of one whose Stop is still ending it. */
const LIVE = new Set(['think', 'gen', 'tool', 'stopping']);
/** Remote-turn states in which the turn is still on its host (app/js/remote.mjs, ON_HOST), awaiting attach among them. */
const ON_HOST = new Set(['running', 'waiting', 'lost', 'stopping']);

/**
 * @typedef {{ state: 'failed'|'you'|'running'|'job'|'behind'|'idle', detail: string, since?: number }} AgentState
 * detail is the step for running, the job’s description or first line for job, and the other agent’s handle for behind.
 */

/**
 * @param {any} se the agent’s session
 * @param {{ threads?: any, sessions?: any, work?: any, inbox?: any }} s the room’s public state
 * @returns {AgentState}
 */
export function agentState(se, s) {
  if (!se) return { state: 'idle', detail: '' };
  if (se.state === 'failed') return { state: 'failed', detail: '' };
  if (se.state === 'needs') return { state: 'you', detail: '' };
  if (LIVE.has(se.state) || ON_HOST.has(se.remoteTurn?.state)) return { state: 'running', detail: se.currentStep ?? '' };
  const conv = conversationRoot(s.threads, se.threadId);
  const job = conv && jobOf(se, s.work?.[conv]);
  if (job) return { state: 'job', detail: job };
  const behind = conv && behindOf(se, conv, s);
  if (behind) return { state: 'behind', detail: behind.handle, since: behind.at };
  return { state: 'idle', detail: '' };
}

/** What names the agent’s newest background command still running: its description, or its command’s first line. */
function jobOf(se, list) {
  for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
    const e = list[i];
    if (e.kind === 'command' && e.sessionId === se.id && e.state === 'background') return e.description || firstLine(e.command);
  }
  return null;
}

const firstLine = (/** @type {string} */ text) => (text ?? '').split('\n')[0].trim();

/**
 * The other agent in the conversation whose inbox holds the agent’s oldest post still waiting, with when it arrived.
 * Delivery’s sender view (services.md, `stateOf`): “waiting behind @x since”.
 */
function behindOf(se, conv, s) {
  /** @type {{ handle: string, at: number } | null} */
  let oldest = null;
  for (const other of Object.values(s.sessions ?? {})) {
    if (other.id === se.id || conversationRoot(s.threads, other.threadId) !== conv) continue;
    for (const e of s.inbox?.[other.id] ?? []) {
      if (e.from === se.handle && e.state === 'waiting' && (!oldest || e.at < oldest.at)) oldest = { handle: other.handle, at: e.at };
    }
  }
  return oldest;
}
