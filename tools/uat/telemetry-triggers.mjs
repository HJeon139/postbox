// The telemetry scenario’s triggers (designs/telemetry-persona.md, U1; tests/uat/e2e/scenarios/telemetry.md): what a
// person does with telemetry that the headless tests can only fake. tools/uat/triggers.mjs adds them to TRIGGERS, and
// reads them the same way: deterministic predicates over the run’s facts.

const FLAG = '🚩';
const roomItems = (f) => (f.threads ?? []).flatMap((t) => f.state?.items?.[t] ?? []);
const reactionsIn = (f) => roomItems(f).flatMap((it) => (it.reactions ?? []).map((r) => ({ ...r, item: it })));
/** The text of each user event in a stream: what the agent was told at the start of a turn, and its tools’ results. */
const toldIn = (s) =>
  (s.events ?? [])
    .filter((e) => e.type === 'user')
    .map((e) => (typeof e.message?.content === 'string' ? e.message.content : JSON.stringify(e.message?.content ?? '')))
    .join('\n');

export const TELEMETRY_TRIGGERS = {
  'canaries-in-room': {
    issue: null,
    says: 'every canary reached the room’s items or an agent’s stream, so the leak check tests something',
    recorded: (f) => !!f.telemetry?.canaries && !!f.state,
    run: (f) => {
      const c = f.telemetry?.canaries;
      if (!c) return [];
      const text = [
        ...roomItems(f).map((i) => `${i.text ?? ''} ${i.block ? JSON.stringify(i.block) : ''}`),
        ...(f.streams ?? []).map((s) => JSON.stringify(s.events ?? [])),
      ].join('\n');
      const missing = Object.entries(c).filter(([, v]) => !text.includes(v));
      return missing.length ? [] : [{ at: null, evidence: `All ${Object.keys(c).length} canaries reached the room: ${Object.keys(c).join(', ')}.` }];
    },
  },
  'recording-started': {
    issue: null,
    says: 'the room records, its header says so, and an agent took a turn after it started',
    recorded: (f) => !!f.state,
    run: (f) => {
      const rec = f.state?.threads?.[f.threads?.[0]]?.recording;
      if (!rec?.on || !/^Recording since \d\d:\d\d$/.test(f.ui?.recordingBadge ?? '')) return [];
      const after = roomItems(f).find((i) => i.kind === 'agent' && i.at > rec.startedAt && i.text);
      return after ? [{ at: after.at, evidence: `The header says “${f.ui.recordingBadge}”, and @${after.handle} replied after it started.` }] : [];
    },
  },
  'flag-reacted': {
    issue: null,
    says: 'a 🚩 reaction was recorded on an item, with its time to detect',
    recorded: (f) => !!f.state,
    run: (f) =>
      reactionsIn(f)
        .filter((r) => r.emoji === FLAG && r.at >= r.item.at)
        .slice(0, 1)
        .map((r) => ({ at: r.at, evidence: `🚩 on ${r.item.kind} ${r.item.id}, ${Math.round((r.at - r.item.at) / 1000)} s after it.` })),
  },
  'feedback-reacted': {
    issue: null,
    says: 'a reaction other than 🚩 was recorded, and the agent it was on was told of it in its next turn',
    recorded: (f) => !!f.state && Array.isArray(f.streams),
    run: (f) =>
      reactionsIn(f)
        .filter((r) => r.emoji !== FLAG && r.item.handle)
        .filter((r) => (f.streams ?? []).some((s) => s.handle === r.item.handle && (s.started ?? 0) > r.at && toldIn(s).includes(`You reacted ${r.emoji}`)))
        .slice(0, 1)
        .map((r) => ({ at: r.at, evidence: `${r.emoji} on @${r.item.handle}’s message, and its next turn was told “You reacted ${r.emoji}”.` })),
  },
  'telemetry-report-saved': {
    issue: null,
    says: 'a report was saved after a line was left out in the Telemetry view',
    recorded: (f) => !!f.telemetry,
    run: (f) =>
      (f.telemetry?.reports ?? [])
        .filter((r) => (f.telemetry.drafts ?? []).some((d) => d?.report?.id === r.id && d.saved && (d.leftOut ?? []).length))
        .map((r) => ({ at: null, evidence: `Report ${r.id} was saved after a line was left out (${r.text.length.toLocaleString('en-US')} bytes).` })),
  },
  'telemetry-file-fallback': {
    issue: null,
    says: 'File issue with no gh showed the issue text, then put it on the clipboard and opened the new-issue page',
    recorded: (f) => !!f.telemetry?.shown,
    run: (f) => {
      const s = f.telemetry?.shown ?? {};
      const tab = (s.opened ?? []).find((t) => /^https:\/\/github\.com\/HJeon139\/postbox\/issues\/new$/.test(t.url));
      const copy = (s.copied ?? []).find((c) => (s.issues ?? []).some((i) => i.text === c.text));
      return tab && copy
        ? [{ at: copy.at, evidence: `It showed the issue, copied its ${copy.text.length.toLocaleString('en-US')} characters, and opened ${tab.url}.` }]
        : [];
    },
  },
};
