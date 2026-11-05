// The triggers of a host-mode run (#120; tools/uat/triggers.mjs has the rest, and what a trigger is): what a phase of
// tests/uat/e2e/scenarios/remotehosts.md, or P0’s Stop phase with its agent on a host, is there to make Postbox show.
// They read what the run recorded (tools/uat/remote-facts.mjs): Postbox’s state and history, the agents’ streams, and
// the runner’s own records in facts.hosts. Each says it can’t tell (recorded false) in a run without hosts.

import { ASKING } from '../../shared/catalog.mjs';
import { triesOf, triesWith } from './host-installs.mjs';
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

/**
 * A host with an older Postbox staged on it (#464) that read not installed before this run’s version ever connected
 * there: the setup’s record (tools/uat/hosts-run.mjs, stageOn; tools/uat/hosts-watch.mjs, hostsUp).
 */
const stagedOlder = (f) =>
  (f.hosts?.setup ?? [])
    .filter((x) => x.staged && Number.isFinite(x.notInstalled) && !(Number.isFinite(x.connected?.at) && x.connected.at <= x.notInstalled))
    .map((x) => ({
      at: x.notInstalled,
      evidence: `${x.label}, with Postbox ${x.staged} staged on it, read not installed before this run’s version ran there.`,
    }));

/**
 * A staged host (#464) where Postbox installed this run’s version by itself, once, from its recorded statuses
 * (tools/uat/host-installs.mjs), and where a turn that started after that install ended ran there and finished. The
 * setup’s record gives the version this run’s Postbox has (tools/uat/hosts-run.mjs, stageOn).
 */
function autoInstalled(f) {
  const recs = remoteTurns(f);
  return installedOnce(f).flatMap(({ x, id, installedAt }) => {
    const t = agentTurns(f).find((t) => t.status === 'done' && recs.get(t.turnId)?.hostId === id && (t.at ?? 0) > installedAt);
    if (!t) return [];
    return [
      { at: t.at, evidence: `${x.label}, staged with Postbox ${x.staged}, installed ${x.runVersion} by itself, then @${t.handle} finished a turn there.` },
    ];
  });
}

/**
 * Each staged host where this run’s version was installed by itself exactly once, with when it was.
 * @param {any} f @returns {{ x: any, id: string, installedAt: number }[]}
 */
function installedOnce(f) {
  return (f.hosts?.setup ?? [])
    .filter((x) => x.staged && typeof x.runVersion === 'string')
    .flatMap((x) => {
      const id = hostIdOf(f, x.label);
      const done = triesWith(triesOf(f, id).get(x.runVersion), new Set(['installed']));
      if (done.length !== 1) return [];
      return [{ x, id, installedAt: /** @type {number} */ (done[0].get('installed')) }];
    });
}

/** The statuses an unanswered card ends in: it expired, or its host ended it (the agent is told for both). */
const ENDED = new Set(['expired', 'ended']);

/**
 * A permission card that expired unanswered, whose agent was told so (`agentTold`, server/permission-expiry.mjs) and
 * whose ring no longer points at it (#721). The note is what main never wrote, so the trigger can’t fire on main.
 */
function expiredNoNeed(f) {
  const sessions = f.state?.sessions ?? {};
  const told = (it) => it.kind === 'permission' && ENDED.has(it.status) && it.agentTold === true;
  return itemsUnderTest(f)
    .filter((it) => told(it) && sessions[it.sessionId]?.needs?.itemId !== it.id)
    .map((it) => ({
      at: Number.isFinite(it.answeredAt) ? it.answeredAt : null,
      evidence: `@${it.handle}’s card ${it.id} “${String(it.summary ?? '').slice(0, 60)}” expired, and @${it.handle} doesn’t need you for it.`,
    }));
}

/**
 * #464-b2b: the first turn on a staged host, which found the older Postbox there, waited while Postbox installed its
 * own version, and then finished there. The turn’s own item appears only once it starts on the host, after the
 * install, so it’s the message that asked for it that came before the install ended.
 * @param {any} f
 */
function waitedForInstall(f) {
  const recs = remoteTurns(f);
  return installedOnce(f).flatMap(({ x, id, installedAt }) => {
    const there = agentTurns(f).filter((t) => recs.get(t.turnId)?.hostId === id);
    const first = there.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0];
    if (first?.status !== 'done') return [];
    const asked = askedAt(f, first);
    if (asked === null || asked >= installedAt) return [];
    return [
      { at: first.at, evidence: `${x.label}’s first turn, @${first.handle}’s, waited while Postbox installed ${x.runVersion} there by itself, then finished.` },
    ];
  });
}

/**
 * When the person’s message just before a turn’s item, in its thread, was sent; null with none.
 * @param {any} f @param {{ turnId: string, threadId: string }} t @returns {number | null}
 */
function askedAt(f, t) {
  const items = f.state?.items?.[t.threadId] ?? [];
  const at = items.findIndex((it) => it?.kind === 'agent' && it.turnId === t.turnId);
  const asked = items.slice(0, Math.max(at, 0)).findLast((it) => it?.kind === 'user');
  return Number.isFinite(asked?.at) ? asked.at : null;
}

/**
 * #464-b3: on a host whose Postbox folder the tester removed (fault remove-postbox), Postbox installed it again by
 * itself with a new token, once, after the removal, and a turn that started after that finished there.
 * @param {any} f
 */
function reinstalled(f) {
  const recs = remoteTurns(f);
  return (f.hosts?.faults ?? [])
    .filter((x) => x.fault === 'remove-postbox')
    .flatMap((x) => {
      const id = hostIdOf(f, x.label);
      const after = [...triesOf(f, id)].flatMap(([version, tries]) =>
        [...tries].filter(([startedAt, outcomes]) => startedAt > x.at && outcomes.has('reinstalled')).map(([, outcomes]) => ({ version, outcomes })),
      );
      if (after.length !== 1) return [];
      const { version, outcomes } = after[0];
      const at = /** @type {number} */ (outcomes.get('reinstalled'));
      const t = agentTurns(f).find((t) => t.status === 'done' && recs.get(t.turnId)?.hostId === id && (t.at ?? 0) > at);
      if (!t) return [];
      return [
        {
          at: t.at,
          evidence: `${x.label}: its folder removed, Postbox installed ${version} there again with a new token, then @${t.handle} finished a turn there.`,
        },
      ];
    });
}

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
  'host-staged-older': {
    issue: 464,
    says: 'a host with an older Postbox on it read not installed, before this run’s version was installed there',
    recorded: hostRun,
    run: stagedOlder,
  },
  'host-auto-installed': {
    issue: 464,
    says: 'Postbox installed its own version by itself, once, on a host with an older one, and a turn then ran there',
    recorded: hostRun,
    run: autoInstalled,
  },
  'expired-card-no-need': {
    issue: 721,
    says: 'a permission card expired before you answered it, and its agent no longer said it needed you for it',
    recorded: hostRun,
    run: (f) => (hostRun(f) ? expiredNoNeed(f) : []),
  },
  'host-reinstalled': {
    issue: 464,
    says: 'Postbox installed itself again with a new token, once, on a host whose Postbox folder was removed, and a turn then ran there',
    recorded: hostRun,
    run: reinstalled,
  },
  'host-turn-waited-install': {
    issue: 464,
    says: 'the first turn on a host with an older Postbox waited while Postbox installed its own version there, then finished',
    recorded: hostRun,
    run: waitedForInstall,
  },
  // A hand-off between machines while a wake card waits (tests/uat/e2e/scenarios/hostwakes.md).
  ...HOSTWAKE_TRIGGERS,
};
