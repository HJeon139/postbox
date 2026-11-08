// #872’s trigger of a host-mode run, host-hung-killed (tools/uat/triggers-host.mjs has the rest): after the tester
// stopped a turn’s runner on a host (fault stop-runner, tools/uat/hosts-watch.mjs), its daemon killed the runner past
// the silence ceiling and ended the turn interrupted, and Postbox resumed it on its own, as one new turn that finished.
//
// The evidence, all from what the run recorded:
// - the fault’s own record (facts.hosts.faults): the host and the host turn whose runner it stopped. With no
//   stop-runner fault there, or one that named no turn, it never fires;
// - the history’s session events (tools/uat/history.mjs; server/room-events.mjs keeps each one’s remoteTurn as
//   { hostId, turn, rtTurn, state }), in their order (seq): that host turn reads interrupted, the end Postbox gives a
//   turn whose `ended` had exit null, and never reads running again after (a second `started` for the old turn);
//   and no other host turn of that session started between the old turn’s first event and that end (a second agent
//   beside it). An `ended` with unkilled reads interrupted too, but Postbox never resumes that one on its own (#872),
//   so no resumed turn follows it;
// - the first other host turn of that session on that host after the end, which is the resume: its agent item in the
//   threads under test finished (done), and no message of the person’s in that thread came between the fault and it,
//   so it’s Postbox’s own resume, not a new message’s turn (the tester has no Resume action).
// Host status events aren’t read: the host stays connected throughout.

import { agentTurns, hostIdOf, itemsUnderTest } from './remote-facts.mjs';

/** The history’s session events with a remote turn on one host, in order. @param {any} f @param {string} hostId */
const onHostEvents = (f, hostId) =>
  (f.events ?? [])
    .filter((e) => e?.type === 'session' && e.data?.remoteTurn?.hostId === hostId && typeof e.data.remoteTurn.turn === 'string')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((e) => ({ sessionId: e.data.id, ...e.data.remoteTurn }));

/**
 * Whether the old host turn had a second start: another host turn of its session started before it ended, or it read
 * running again after. @param {any[]} evs  its session’s events on the host @param {string} turn @param {number} end
 */
function secondStart(evs, turn, end) {
  const first = evs.findIndex((e) => e.turn === turn);
  if (evs.slice(first, end).some((e) => e.turn !== turn)) return true;
  return evs.slice(end + 1).some((e) => e.turn === turn && e.state === 'running');
}

/** @param {any} f */
function hungKilled(f) {
  return (f.hosts?.faults ?? [])
    .filter((x) => x.fault === 'stop-runner' && typeof x.turn === 'string')
    .flatMap((x) => {
      const all = onHostEvents(f, hostIdOf(f, x.label));
      const ended = all.find((e) => e.turn === x.turn && e.state === 'interrupted');
      if (!ended) return [];
      const evs = all.filter((e) => e.sessionId === ended.sessionId);
      const end = evs.findIndex((e) => e.turn === x.turn && e.state === 'interrupted');
      if (secondStart(evs, x.turn, end)) return [];
      const next = evs.slice(end + 1).find((e) => e.turn !== x.turn);
      const t = next && agentTurns(f).find((t) => t.turnId === next.rtTurn);
      if (t?.status !== 'done') return [];
      const asked = itemsUnderTest(f).some((it) => it.kind === 'user' && it.threadId === t.threadId && it.at > x.at && it.at < (t.at ?? 0));
      if (asked) return [];
      return [
        {
          at: t.at,
          evidence: `${x.label}: @${t.handle}’s runner (process ${x.pid}) stopped; its turn ended interrupted once, Postbox resumed it on its own, and the resumed turn finished.`,
        },
      ];
    });
}

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const HUNG_TRIGGERS = {
  'host-hung-killed': {
    issue: 872,
    says: 'a turn whose runner on a host was stopped ended interrupted once, and Postbox resumed it on its own, and it finished',
    recorded: (f) => Boolean(f.hosts?.hosts?.length),
    run: hungKilled,
  },
};
