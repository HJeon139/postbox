// Triggers for a room that stops while work waits (#1746; tools/uat/triggers.mjs has what a trigger is): the team
// handed work between agents, a timed step was started, the room was then left quiet while the work waited, and an
// ask was shown while its turn ran. Each says the run reached the situation, not how Postbox handled it: the checks
// say that (tools/uat/room-checks-idle.mjs). The sprint’s ceremonies have their own (tools/uat/sprint-triggers.mjs).

import { workOf } from './board-log.mjs';
import { midTurnAsks } from './mid-turn-asks.mjs';
import { nightlyWork } from './nightly-log.mjs';
import { clockOf, quietStretches } from './quiet-stretches.mjs';
import { lengthOf, QUIET_LISTED_MS } from './room-checks-idle.mjs';

/** How long a turn has to go on after an ask for the ask to have been shown mid-turn, not on the turn’s closing line. */
export const MID_TURN_MS = 30_000;

/**
 * Each message one agent’s turn took from another agent, from the inboxes’ entries: who sent it, who took it, when.
 * @param {{ events?: any[] }} f
 */
export function handOffs(f) {
  /** @type {Map<string, string>} */
  const handles = new Map();
  /** @type {Map<string, { from: string, to: string, at: number }>} */
  const waiting = new Map();
  const out = [];
  for (const e of f.events ?? []) {
    const d = e?.data;
    if (e?.type === 'session' && d?.id && typeof d.handle === 'string') handles.set(d.id, d.handle);
    else if (e?.type === 'entry.add' && d?.entry?.from && d.entry.from !== 'you') {
      const to = handles.get(d.sessionId);
      if (to) waiting.set(d.entry.id, { from: d.entry.from, to, at: d.entry.at ?? null });
    } else if (e?.type === 'entry.patch' && d?.patch?.state === 'taken' && waiting.has(d.id)) {
      out.push(/** @type {{ from: string, to: string, at: number }} */ (waiting.get(d.id)));
      waiting.delete(d.id);
    }
  }
  return out;
}

/**
 * Each quiet stretch of a minute or more that ended, with the work not done and nobody asked: waiting on a scheduled
 * wake, or on nothing at all.
 * @param {any} f  @param {import('./quiet-stretches.mjs').Work} [work]
 */
export function quietWhileWaiting(f, work = workOf(f)) {
  return quietStretches(f, work)
    .filter((s) => !s.open && s.ms >= QUIET_LISTED_MS && s.work !== 'done' && (s.waiting === 'nothing' || s.waiting === 'scheduled'))
    .map((s) => ({ at: s.to, evidence: `Quiet for ${lengthOf(s.ms)} from ${clockOf(s.from)}, until ${s.movedBy}.` }));
}

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const IDLE_TRIGGERS = {
  'work-handed-between-agents': {
    issue: 1746,
    says: 'work went from one agent to another twice or more, between at least three agents, with no message from the person',
    recorded: (f) => (f.events ?? []).some((/** @type {any} */ e) => e?.type === 'entry.add'),
    run: (f) => {
      const all = handOffs(f);
      const pairs = [...new Map(all.map((h) => [`${h.from}>${h.to}`, h])).values()];
      const agents = new Set(pairs.flatMap((h) => [h.from, h.to]));
      if (pairs.length < 2 || agents.size < 3) return [];
      return [{ at: pairs[1].at, evidence: `${all.length} hand-offs: ${pairs.map((h) => `@${h.from} to @${h.to}`).join(', ')}.` }];
    },
  },
  'timed-step-queued': {
    issue: 1746,
    says: 'an agent queued the nightly check, which finishes later with no message',
    recorded: (f) => typeof f.workspace === 'string',
    run: (f) => {
      const { queued } = nightlyWork(f);
      if (!queued) return [];
      return [{ at: queued.at, evidence: `Queued at ${clockOf(queued.at)}${queued.due ? `, due at ${clockOf(queued.due)}` : ''}.` }];
    },
  },
  'room-quiet-while-work-waited': {
    issue: 1746,
    says: 'the room was quiet for a minute or more while the work wasn’t done and nobody had been asked anything, then moved again',
    recorded: (f) => Array.isArray(f.events) && f.events.length > 0,
    run: (f) => quietWhileWaiting(f),
  },
  'ask-shown-mid-turn': {
    issue: 1746,
    says: `an agent showed a block that asks, and its turn went on for ${MID_TURN_MS / 1000} s or more after it`,
    recorded: (f) => Array.isArray(f.events) && f.events.length > 0,
    run: (f) =>
      midTurnAsks(f)
        .filter((a) => a.turnMs >= MID_TURN_MS)
        .map((a) => ({ at: a.shownAt, evidence: `@${a.handle} showed “${a.title}” at ${clockOf(a.shownAt)}, and its turn ran ${lengthOf(a.turnMs)} more.` })),
  },
};
