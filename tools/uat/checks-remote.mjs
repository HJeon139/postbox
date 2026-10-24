// The checks of a host-mode run (#120), and what changes for the others when a turn ran on a host
// (tools/uat/checks.mjs has the rest; tools/uat/remote-facts.mjs, what a host-mode run records).
//
// Some checks can’t see a turn on a host. settings-leak, mcp-servers-missing and mcp-side-channel read the person’s
// setup on this computer, or an HTTP route only an agent here has: over a remote turn they would pass without having
// checked anything. They run over this computer’s turns only, and once the run has ended they say how many remote
// turns they couldn’t judge, as a measurement, never as a pass. work-files-match-stream judges a remote turn by what
// the ledger records there by design: a file an agent changed on a host is an edit step with no diff
// (server/ledger-remote.mjs), never a file of this computer’s.

import { agentTurns, hostIdOf, hostTurnIds, labelOf, localFacts, placeOf, remoteStream, remoteTurns, toolUses } from './remote-facts.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NOT_HERE = new Set(['settings-leak', 'mcp-servers-missing', 'mcp-side-channel']);
const list = (xs, n = 5) => `${xs.slice(0, n).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How many recorded turns ran on a host. */
const remoteCount = (f) => (f.streams ?? []).filter((s) => remoteStream(f, s)).length;

/** A check that can’t see a remote turn: this computer’s turns only, and at the end, how many it couldn’t judge. */
const hereOnly = (c) => ({
  ...c,
  run: (f) => {
    const out = c.run(localFacts(f));
    const n = remoteCount(f);
    if (!f.hosts?.ended || !n) return out;
    return [
      ...out,
      {
        key: 'not-applicable:remote',
        issue: null,
        title: `${c.id}: not applicable to ${plural(n, 'remote turn')}`,
        evidence: `It reads what only a turn on this computer has (the person’s setup here, or Postbox’s HTTP route), so it judged ${plural((f.streams ?? []).length - n, 'turn')} here and none of the ${n} on a host.`,
        verdict: 'measurement',
        note: 'Not a defect: what this check reads isn’t there on a host.',
      },
    ];
  },
});

/** A file an agent changed on a host must be in Work as an edit step on the host, with no diff of this computer’s. */
function remoteEdits(f) {
  const work = Object.values(f.state?.work ?? {}).flat();
  const steps = new Set(work.filter((e) => e.kind === 'edit').map((e) => e.path));
  const files = new Set(work.filter((e) => e.kind === 'file').map((e) => e.path));
  const edited = new Set(
    (f.streams ?? [])
      .filter((s) => remoteStream(f, s))
      .flatMap((s) => toolUses(s.events).filter((c) => EDIT_TOOLS.has(c.name) && c.ok))
      .map((c) => c.input.file_path ?? c.input.notebook_path)
      .filter(Boolean),
  );
  const out = [];
  const asFiles = [...edited].filter((p) => files.has(p));
  const missing = [...edited].filter((p) => !steps.has(p) && !files.has(p));
  if (asFiles.length)
    out.push({
      key: 'remote-as-file',
      title: 'A file an agent changed on a host is in the Work view as a file of this computer’s',
      evidence: `With a diff, though Postbox never reads files on a host: ${list(asFiles)}.`,
    });
  if (missing.length)
    out.push({
      key: 'remote-missing',
      title: 'A file an agent changed on a host isn’t in the Work view as a step there',
      evidence: `Changed by an Edit or Write call on a host, with no edit step: ${list(missing)}.`,
    });
  return out;
}

/** CHECKS with the remote rules: wraps the checks a remote turn changes, and adds the host-mode checks. @param {any[]} checks */
export function withRemote(checks) {
  return [
    ...checks.map((c) => {
      if (NOT_HERE.has(c.id)) return hereOnly(c);
      if (c.id === 'work-files-match-stream') return { ...c, run: (f) => [...c.run(localFacts(f)), ...remoteEdits(f)] };
      return c;
    }),
    ...REMOTE_CHECKS,
  ];
}

/** Each turn of a placed agent ran on its host, and a turn of an agent here on none. */
function ranOnItsHost(f) {
  const recs = remoteTurns(f);
  return agentTurns(f).flatMap((t) => {
    const place = placeOf(f, t.handle);
    const rec = recs.get(t.turnId);
    if (place === 'local') {
      if (!rec) return [];
      return [
        {
          key: t.turnId,
          title: 'A turn of an agent on this computer ran on a host',
          evidence: `@${t.handle}’s turn ${t.turnId} has host turn ${rec.turn} on ${labelOf(f, rec.hostId) ?? rec.hostId}.`,
        },
      ];
    }
    if (rec?.hostId === hostIdOf(f, place)) return [];
    // A turn that failed before it reached the host is failed-turn’s.
    if (!rec && t.status === 'failed') return [];
    return [
      {
        key: t.turnId,
        title: `A turn of an agent placed on ${place} didn’t run there`,
        evidence: rec
          ? `@${t.handle}’s turn ${t.turnId} ran on ${labelOf(f, rec.hostId) ?? rec.hostId} (host turn ${rec.turn}), not ${place}.`
          : `@${t.handle}’s turn ${t.turnId} (${t.status}) has no remote turn in Postbox’s state or history: it ran on this computer.`,
      },
    ];
  });
}

/** The host’s own list of turns, read over the runner’s ssh at the end, against the ones Postbox recorded there. */
function turnsListed(f) {
  if (!f.hosts?.listed) return [];
  return (f.hosts.hosts ?? []).flatMap((h) => {
    const listed = new Set(f.hosts.listed[h.label] ?? []);
    const before = new Set(f.hosts.before?.[h.label] ?? []);
    const recorded = hostTurnIds(f, h.id);
    const missing = recorded.filter((id) => !listed.has(id));
    const unknown = [...listed].filter((id) => !before.has(id) && !recorded.includes(id));
    return [
      ...(missing.length
        ? [
            {
              key: `missing:${h.label}`,
              title: `Turns Postbox recorded on ${h.label} aren’t on it`,
              evidence: `Not in ~/.postbox-remote/turns there: ${list(missing)}.`,
            },
          ]
        : []),
      ...(unknown.length
        ? [
            {
              key: `unknown:${h.label}`,
              title: `${h.label} has turns Postbox didn’t record`,
              evidence: `In ~/.postbox-remote/turns, and in no remoteTurn of Postbox’s: ${list(unknown)}.`,
            },
          ]
        : []),
    ];
  });
}

/** The end-of-run checks over each host: nothing left after the idle timeout, and nothing after Remove. */
function hostDoneWhen(f) {
  return (f.hosts?.hosts ?? []).flatMap((h) => {
    const idle = f.hosts.idle?.[h.label];
    const removed = f.hosts.removed?.[h.label];
    const out = [];
    if (idle?.skipped)
      out.push({
        key: `idle-skipped:${h.label}`,
        issue: null,
        title: `${h.label}: the idle exit wasn’t checked`,
        evidence: idle.skipped,
        verdict: 'measurement',
        note: 'Not a defect: what this run didn’t check.',
      });
    else if (idle?.left?.length)
      out.push({
        key: `idle:${h.label}`,
        title: `Postbox still ran on ${h.label} after its idle timeout`,
        evidence: `${Math.round(idle.waited / 1000)} s after the last turn: ${list(idle.left, 4)}.`,
      });
    if (removed?.error) out.push({ key: `remove:${h.label}`, title: `Removing ${h.label} through Settings failed`, evidence: removed.error });
    else if (removed?.exists)
      out.push({
        key: `remove:${h.label}`,
        title: `~/.postbox-remote was still on ${h.label} after Remove`,
        evidence: `test -e ~/.postbox-remote held after “${String(removed.confirm ?? '').slice(0, 120)}”.`,
      });
    if (removed?.left?.length)
      out.push({ key: `remove-left:${h.label}`, title: `Postbox still ran on ${h.label} after Remove`, evidence: list(removed.left, 4) });
    return out;
  });
}

export const REMOTE_CHECKS = [
  { id: 'ran-on-its-host', issue: 120, run: ranOnItsHost },
  { id: 'host-turns-listed', issue: 120, run: turnsListed },
  { id: 'host-done-when', issue: 120, run: hostDoneWhen },
  {
    // A new TCP listener of the run’s own processes during a turn: Postbox’s or its daemon’s on a host, or Postbox’s
    // and its children’s here (tools/uat/hosts-probe.mjs). Other processes’ come and go on a shared machine.
    id: 'host-listeners',
    issue: 120,
    run: (f) =>
      (f.hosts?.listeners?.samples ?? [])
        .filter((s) => s.run?.length)
        .map((s) => ({
          key: `${s.where}:${s.run.join(',')}`,
          title: `A new TCP listener during a turn, on ${s.where === 'local' ? 'this computer' : s.where}`,
          evidence: `Not there before setup, and the run’s own: ${list(s.run, 4)}.`,
        })),
  },
  {
    id: 'remote-stop-left-processes',
    issue: 120,
    run: (f) =>
      (f.hosts?.stops ?? []).flatMap((x) => [
        ...(x.left?.length
          ? [
              {
                key: `left:${x.turn}`,
                title: 'A stopped turn left processes running on its host',
                evidence: `After @${x.handle}’s Stop, on ${x.label}: ${list(x.left, 4)}.`,
              },
            ]
          : []),
        ...(x.jobs > 0 && !/stops with its turn/.test(x.note ?? '')
          ? [
              {
                key: `silent:${x.turn}`,
                title: 'Stop didn’t say beforehand that a job on the host stops with the turn',
                evidence: `@${x.handle} had ${plural(x.jobs, 'background job')} on ${x.label}; the composer said “${x.note ?? 'nothing'}”.`,
              },
            ]
          : []),
      ]),
  },
  {
    id: 'fault-not-recovered',
    issue: 120,
    run: (f) =>
      (f.hosts?.faults ?? [])
        .filter((x) => x.recovered === false)
        .map((x) => ({
          key: `${x.fault}:${x.at}`,
          title: `After ${x.fault}${x.label ? ` on ${x.label}` : ''}, the host didn’t read Connected again`,
          evidence: x.shown ?? '',
        })),
  },
  {
    // The defect the researcher expected before the fix (runtime.mjs → blobs.pathOf; guide.mjs): an agent on a host
    // pointed at an attachment’s path on this computer, which it can’t read.
    id: 'attachment-laptop-path',
    issue: 120,
    run: (f) => {
      const data = f.hosts?.laptopData;
      if (!data) return [];
      return (f.streams ?? [])
        .filter((s) => remoteStream(f, s))
        .flatMap((s) =>
          toolUses(s.events)
            .filter((c) => JSON.stringify(c.input).includes(data))
            .map((c) => ({ s, c })),
        )
        .map(({ s, c }) => ({
          key: c.id,
          title: 'An agent on a host was given a path on this computer',
          evidence: `@${s.handle}’s ${c.name} on ${placeOf(f, s.handle)} named ${data}: ${JSON.stringify(c.input).slice(0, 160)}.`,
        }));
    },
  },
  {
    // Setting a host up as a person would (tools/uat/driver-hosts.mjs): a host just added must offer Install.
    id: 'host-install-offered',
    issue: 120,
    run: (f) =>
      (f.hosts?.setup ?? [])
        .filter((s) => s.installOffered === false)
        .map((s) => ({
          key: s.label,
          title: 'The Hosts tab offers no Install for a host just added',
          evidence: `${s.label}’s card read “${String(s.card ?? '').slice(0, 160)}”, with no Install…; the runner opened the install confirm itself.`,
        })),
  },
];
