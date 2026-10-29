// The triggers of a host-mode run (#120; tools/uat/triggers.mjs has the rest, and what a trigger is): what a phase of
// tests/uat/e2e/scenarios/remotehosts.md, or P0’s Stop phase with its agent on a host, is there to make Postbox show.
// They read what the run recorded (tools/uat/remote-facts.mjs): Postbox’s state and history, the agents’ streams, and
// the runner’s own records in facts.hosts. Each says it can’t tell (recorded false) in a run without hosts.

import { ASKING } from '../../shared/catalog.mjs';
import { agentTurns, hostIdOf, itemsUnderTest, labelOf, onHost, placeOf, remoteStream, remoteTurns, toolUses } from './remote-facts.mjs';
import { HOSTWAKE_TRIGGERS } from './triggers-hostwakes.mjs';

const MINUTE = 60_000;
const hostRun = (f) => Boolean(f.hosts?.hosts?.length);
const answeredCard = (it) => it.kind === 'permission' && it.remote && /^(allowed|denied)/.test(String(it.status)) && Number.isFinite(it.answeredAt);
const faultsOf = (f, fault) => (f.hosts?.faults ?? []).filter((x) => x.fault === fault);

/** A turn ran where its agent is placed: one with a remote turn on its host, or, for this computer, one with none. */
function ranWhere(f, t, recs) {
  const place = placeOf(f, t.handle);
  const rec = recs.get(t.turnId);
  return place === 'local' ? !rec : rec?.hostId === hostIdOf(f, place);
}

/** Each place (every host, and this computer) where a placed agent finished a turn that ran there. */
function turnOnEachPlace(f) {
  const recs = remoteTurns(f);
  const places = new Set(Object.values(f.hosts.placement ?? {}));
  const done = new Map();
  for (const t of agentTurns(f))
    if (t.status === 'done' && Object.hasOwn(f.hosts.placement ?? {}, t.handle) && ranWhere(f, t, recs) && !done.has(placeOf(f, t.handle)))
      done.set(placeOf(f, t.handle), t);
  if (!places.size || [...places].some((p) => !done.has(p))) return [];
  const at = Math.max(...[...done.values()].map((t) => t.at ?? 0)) || null;
  return [{ at, evidence: [...done.entries()].map(([p, t]) => `@${t.handle} finished a turn ${p === 'local' ? 'here' : `on ${p}`}`).join('; ') + '.' }];
}

/** A block that asks, by an agent on a host, that the person answered. @param {(type: string) => boolean} kind */
const remoteBlocks = (kind) => (f) =>
  itemsUnderTest(f)
    .filter((it) => it.kind === 'block' && it.valid !== false && kind(it.block?.type) && it.answered && onHost(f, it.handle))
    .map((it) => ({
      at: Number.isFinite(it.answer?.at) ? it.answer.at : null,
      evidence: `You answered @${it.handle}’s ${it.block.type} “${String(it.block.title ?? it.block.id ?? '').slice(0, 60)}”, from ${placeOf(f, it.handle)}.`,
    }));

/** A wake_agent call Postbox applied, from an agent in one place to an agent in another. */
function crossWakes(f) {
  return (f.streams ?? []).flatMap((s) =>
    toolUses(s.events)
      .filter((c) => c.ok && /^mcp__[\w-]+__wake_agent$/.test(c.name))
      .map((c) => ({ c, to: String(c.input?.handle ?? '').replace(/^@/, '') }))
      .filter(({ to }) => to && placeOf(f, to) !== placeOf(f, s.handle))
      .map(({ c, to }) => ({ at: c.at, evidence: `@${s.handle} (${placeOf(f, s.handle)}) woke @${to} (${placeOf(f, to)}).` })),
  );
}

/** A fault, after which every host it touched read Connected again. @param {string} fault */
const recovered = (fault) => (f) =>
  faultsOf(f, fault)
    .filter((x) => x.recovered)
    .map((x) => ({ at: x.at ?? null, evidence: `${fault}${x.label ? ` on ${x.label}` : ''}: ${x.shown ?? 'Postbox read Connected again.'}` }));

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const HOST_TRIGGERS = {
  'turn-on-each-place': {
    issue: 120,
    says: 'a turn of a placed agent ran where it’s placed, on each host and on this computer',
    recorded: hostRun,
    run: (f) => (hostRun(f) ? turnOnEachPlace(f) : []),
  },
  'remote-block-answered': {
    issue: 120,
    says: 'an agent on a host showed a block that asks, and your answer reached it',
    recorded: hostRun,
    run: remoteBlocks((t) => ASKING.has(t) && t !== 'review'),
  },
  'remote-review-answered': {
    issue: 120,
    says: 'an agent on a host put a draft up for review, and you answered it',
    recorded: hostRun,
    run: remoteBlocks((t) => t === 'review'),
  },
  'remote-card-after-a-minute': {
    issue: 120,
    says: 'a permission card from a host was answered more than a minute after it appeared',
    recorded: hostRun,
    run: (f) =>
      itemsUnderTest(f)
        .filter((it) => answeredCard(it) && Number.isFinite(it.at) && it.answeredAt - it.at > MINUTE)
        .map((it) => ({
          at: it.answeredAt,
          evidence: `@${it.handle}’s card “${it.summary}” was answered after ${Math.round((it.answeredAt - it.at) / 1000)} s.`,
        })),
  },
  'remote-attachment-read': {
    issue: 120,
    says: 'an agent on a host read a file you attached, from its copy on the host',
    recorded: hostRun,
    run: (f) =>
      (f.streams ?? [])
        .filter((s) => remoteStream(f, s))
        .flatMap((s) => toolUses(s.events).map((c) => ({ s, c })))
        .filter(({ c }) => c.ok && /\/\.postbox-remote\/turns\/[^"]+\/attachments\//.test(JSON.stringify(c.input)))
        .map(({ s, c }) => ({
          at: c.at,
          evidence: `@${s.handle}’s ${c.name} read ${String(c.input?.file_path ?? c.input?.path ?? 'its attachment').slice(-80)}.`,
        })),
  },
  'cross-host-wake': {
    issue: 120,
    says: 'an agent woke an agent that runs on another machine',
    recorded: hostRun,
    run: (f) => (hostRun(f) ? crossWakes(f) : []),
  },
  'remote-stop-says-jobs': {
    issue: 120,
    says: 'before Stop, it said that the background job on the host stops with the turn, and you stopped the agent',
    recorded: hostRun,
    run: (f) =>
      (f.hosts?.stops ?? [])
        .filter((x) => x.jobs > 0 && /stops with its turn/.test(x.note ?? ''))
        .map((x) => ({ at: x.at ?? null, evidence: `Before Stop, Postbox said: “${x.note}”` })),
  },
  'remote-stop-no-process-left': {
    issue: 120,
    says: 'after Stop on an agent with a background job on a host, nothing of that turn was left running there',
    recorded: hostRun,
    run: (f) =>
      (f.hosts?.stops ?? [])
        .filter((x) => x.jobs > 0 && x.watched > 0 && Array.isArray(x.left) && !x.left.length)
        .map((x) => ({
          at: x.at ?? null,
          evidence: `After @${x.handle}’s Stop, none of the ${x.watched} processes seen under host turn ${x.turn} ran on ${x.label}.`,
        })),
  },
  'fault-kill-ssh': {
    issue: 120,
    says: 'the host read Connected again on its own after its ssh connection was killed',
    recorded: hostRun,
    run: recovered('kill-ssh'),
  },
  'fault-restart-postbox': {
    issue: 120,
    says: 'the hosts read Connected again after Postbox restarted on the same data',
    recorded: hostRun,
    run: recovered('restart-postbox'),
  },
  'fault-kill-daemon': { issue: 120, says: 'the host read Connected again after its daemon was killed', recorded: hostRun, run: recovered('kill-daemon') },
  'remote-card-while-disconnected': {
    issue: 120,
    says: 'a permission card from a host, open when its ssh connection was killed, was answered after it reconnected',
    recorded: hostRun,
    run: (f) =>
      itemsUnderTest(f)
        .filter((it) => answeredCard(it))
        .flatMap((it) =>
          faultsOf(f, 'kill-ssh')
            // Only a kill that cut the host off counts: one it never noticed shows nothing about a card across a drop.
            .filter((x) => x.recovered === true && x.label === labelOf(f, it.remote.hostId) && x.at > it.at && x.at < it.answeredAt)
            .map((x) => ({
              at: it.answeredAt,
              evidence: `@${it.handle}’s card “${it.summary}” was open when ${x.label}’s ssh was killed, and was answered ${it.status}.`,
            })),
        ),
  },
  // A hand-off between machines while a wake card waits (tests/uat/e2e/scenarios/hostwakes.md).
  ...HOSTWAKE_TRIGGERS,
};
