// What a host-mode run (#120; tools/uat/hosts-run.mjs) knows about where each turn ran, for its checks
// (tools/uat/checks-remote.mjs) and triggers (tools/uat/triggers-host.mjs). Pure functions over the run’s facts:
//
//   facts.hosts = {
//     hosts:      [{ label: 'host1', id, destination }]  each --host, in order, and the host Postbox made for it
//     placement:  { researcher: 'host1', critic: 'local' }  where the runner put each scenario agent
//     laptopData: the run’s Postbox data folder, whose paths an agent on a host can’t read
//     setup:      [{ label, installOffered, confirm, connected }]  what setting each host up through the UI showed
//     listeners:  { baseline: { local, host1… }, samples: [{ where, at, added, run }] }  TCP listeners (hosts-probe.mjs)
//     stops:      [{ handle, label, turn, at, note, jobs, left }]  a Stop on a placed agent, and what was left on its host
//     faults:     [{ fault, label, at, states, recovered, shown }]  what the tester broke on purpose, and what Postbox showed
//     before:     { host1: [turn IDs] }  turns already on each host before the run set it up
//     listed:     { host1: [turn IDs] }  ~/.postbox-remote/turns on each host at the run’s end
//     idle:       { host1: { left: [lines], waited, skipped? } }  what of Postbox still ran after the idle timeout
//     removed:    { host1: { confirm, exists, error? } }  Remove through the UI, and whether ~/.postbox-remote stayed
//     ended:      true once the end-of-run checks ran
//   }
//
// Postbox’s own record of a remote turn is its session’s remoteTurn ({ hostId, turn, rtTurn }), which the history keeps
// at each session event (tools/uat/history.mjs): rtTurn is Postbox’s turn, turn the host’s.

/** Where an agent runs in this run: a host’s label, or 'local'. Unplaced agents, and a run without hosts, are local. */
export const placeOf = (f, handle) => f.hosts?.placement?.[handle] ?? 'local';
/** The host Postbox made for a label. */
export const hostIdOf = (f, label) => f.hosts?.hosts?.find((h) => h.label === label)?.id ?? null;
/** The label of a host Postbox made. */
export const labelOf = (f, hostId) => f.hosts?.hosts?.find((h) => h.id === hostId)?.label ?? null;
/** Whether an agent runs on a host in this run. */
export const onHost = (f, handle) => placeOf(f, handle) !== 'local';

/**
 * Every remote turn Postbox recorded, by its own turn: from the history’s session events and the state now.
 * @returns {Map<string, { hostId: string, turn: string, sessionId: string }>}
 */
export function remoteTurns(f) {
  const out = new Map();
  const take = (sessionId, r) => {
    if (r && typeof r.rtTurn === 'string' && typeof r.hostId === 'string' && typeof r.turn === 'string')
      out.set(r.rtTurn, { hostId: r.hostId, turn: r.turn, sessionId });
  };
  for (const e of f.events ?? []) if (e?.type === 'session' && e.data?.remoteTurn) take(e.data.id, e.data.remoteTurn);
  for (const se of Object.values(f.state?.sessions ?? {})) take(se?.id, se?.remoteTurn);
  return out;
}

/** The host turn IDs Postbox recorded on one host. @param {any} f @param {string} hostId */
export const hostTurnIds = (f, hostId) => [...new Set([...remoteTurns(f).values()].filter((r) => r.hostId === hostId).map((r) => r.turn))];

/**
 * The agent turns in the threads under test, one per turn: who, which session, and how it ended.
 * @returns {{ turnId: string, handle: string, sessionId: string, status: string, at: number|null, threadId: string }[]}
 */
export function agentTurns(f) {
  const out = new Map();
  for (const t of f.threads ?? [])
    for (const it of f.state?.items?.[t] ?? [])
      if (it?.kind === 'agent' && it.turnId && !out.has(it.turnId))
        out.set(it.turnId, { turnId: it.turnId, handle: it.handle, sessionId: it.sessionId, status: it.status, at: it.at ?? null, threadId: t });
  return [...out.values()];
}

/** Whether a recorded stream is a turn of an agent on a host. */
export const remoteStream = (f, s) => onHost(f, s.handle);

/** The facts with only this computer’s turns’ streams, for a check that can’t see a turn on a host. */
export const localFacts = (f) => ({ ...f, streams: (f.streams ?? []).filter((s) => !remoteStream(f, s)) });

/**
 * Every tool call in a stream, with whether it succeeded: a result that isn’t an error.
 * @param {any[]} events @returns {{ id: string, name: string, input: any, ok: boolean, at: number|null }[]}
 */
export function toolUses(events) {
  const results = new Map();
  for (const e of events ?? [])
    if (e?.type === 'user')
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b?.type === 'tool_result') results.set(b.tool_use_id, b);
  return (events ?? [])
    .filter((e) => e?.type === 'assistant')
    .flatMap((e) =>
      (Array.isArray(e.message?.content) ? e.message.content : [])
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          name: String(b.name ?? ''),
          input: b.input ?? {},
          ok: results.has(b.id) && results.get(b.id).is_error !== true,
          at: Number.isFinite(Date.parse(e.timestamp)) ? Date.parse(e.timestamp) : null,
        })),
    );
}

/** Items in the threads under test, with their thread. */
export const itemsUnderTest = (f) => (f.threads ?? []).flatMap((t) => (f.state?.items?.[t] ?? []).map((it) => ({ ...it, threadId: t })));
