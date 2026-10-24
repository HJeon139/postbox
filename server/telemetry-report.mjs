// A telemetry report, on request (designs/telemetry-persona.md, R2, R3, R8, R12–R16, R18): the record of the room, the
// checks a live room can run, one classifier call, the gate, and the bytes Postbox builds from what passed. The draft
// stays in the recording, local, until you save it (server/telemetry-save.mjs); the Telemetry view shows its bytes.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { finalCheck, labelsOf } from '../shared/telemetry.mjs';
import { jsonLines, leaveOut, pruned } from '../shared/telemetry-bytes.mjs';
import { FLAG } from '../shared/telemetry-vocab.mjs';
import { httpError } from './helpers.mjs';
import { CHECKS, liveChecks } from './room-checks.mjs';
import { newId } from './store.mjs';
import { convOf, folder, readLines, write } from './telemetry.mjs';
import { classifierInput, classify } from './telemetry-classify.mjs';
import { collect, tierA } from './telemetry-record.mjs';

const BY_BACKEND = { 'kiro-cli': 'kiroStreams', 'antigravity-cli': 'agyStreams', codex: 'codexStreams' };

/** What the final check needs from Postbox itself: its check ids, and this build’s version and commit. */
export const vocabOf = (rt) => ({ checkIds: CHECKS.map((c) => c.id), build: rt.config.build ?? {} });

/** A draft’s bytes, as shown and saved: its report less the lines left out, and their hash. */
export function bytesOf(draft) {
  const report = leaveOut(draft.report, draft.leftOut ?? []);
  const { text } = jsonLines(report);
  return { report, text, hash: createHash('sha256').update(text).digest('hex') };
}

/** The UAT’s facts for the room (server/room-checks.mjs), from what was recorded. */
function liveFacts(rt, c) {
  const items = { ...rt.s.items };
  for (const id of c.threads) items[id] = (rt.s.items[id] ?? []).filter((it) => it.at >= c.since);
  /** @type {Record<string, any>} */
  const f = { state: { ...rt.s, items }, threads: c.threads, streams: [], kiroStreams: [], agyStreams: [], codexStreams: [], transcripts: [], gaps: [] };
  for (const t of c.turns.filter((x) => x.recorded))
    f[BY_BACKEND[t.backend] ?? 'streams'].push({
      handle: rt.s.sessions[t.sessionId]?.handle ?? '',
      events: t.events,
      started: t.startedAt,
      ended: t.endedAt ?? undefined,
    });
  f.events = readLines(join(c.dir, 'events.jsonl'));
  const projects = rt.config.claudeProjectsRoot ?? join(rt.home ?? homedir(), '.claude', 'projects');
  const cwd = rt.s.projects[c.conv.projectId]?.folder ?? '';
  for (const id of c.threads.flatMap((t) => rt.s.threads[t]?.members ?? [])) {
    const se = rt.s.sessions[id];
    const sid = se?.backendState?.claudeSessionId;
    if (!sid || !c.agents.has(se.personaId)) continue;
    try {
      f.transcripts.push({ handle: se.handle, lines: readFileSync(join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`), 'utf8').split('\n') });
    } catch {
      f.gaps.push({ kind: 'transcript', agent: c.agents.get(se.personaId).id, reason: 'unreadable' });
    }
  }
  return f;
}

/** The checks’ findings, one row per check, with the refs of the items and turns they name (R12, Check finding). */
function checksOf(c, live) {
  const threw = live.findings.filter((f) => f.key === `${f.check}-error`);
  const found = new Map();
  for (const f of live.findings.filter((x) => !threw.includes(x))) found.set(f.check, [...(found.get(f.check) ?? []), f]);
  const rows = [...found.entries()].map(([check, fs], i) => {
    const refs = [...new Set(fs.map((f) => c.byItem.get(f.key) ?? c.byTurn.get(f.key)).filter(Boolean))];
    return { ref: `c${i + 1}`, check, issue: fs[0].issue ?? null, count: fs.length, refs };
  });
  return { rows, threw: threw.map((f) => ({ kind: 'check', check: f.check, reason: 'threw' })) };
}

/**
 * Makes a report: the record, the checks, the classifier’s labels through the gate, and the bytes. Returns the draft’s
 * id; the Telemetry view reads it with draftView.
 * @param {any} rt @param {string} threadId @param {{ history?: boolean }} [opts]
 */
export async function makeReport(rt, threadId, { history = false } = {}) {
  const conv = convOf(rt, threadId);
  if (!conv?.recording) throw httpError(409, 'This conversation has no recording. Choose Record this room first.');
  const dir = folder(rt, conv.id);
  const c = collect(rt, conv, dir, { history: history === true });
  const facts = liveFacts(rt, c);
  const live = liveChecks(facts);
  const checks = checksOf(c, live);
  const a = tierA(rt, c);
  const flags = a.reactions.filter((r) => r.emoji === FLAG);
  const asked = [
    ...checks.rows.map((k) => ({ ref: k.ref, item: k.refs.find((x) => x.startsWith('i')) ?? null })),
    ...flags.map((r) => ({ ref: r.ref, item: r.on })),
  ];
  const proposals = process.env.POSTBOX_TELEMETRY_PROPOSALS === '1';
  const record = { ...a, checks: { found: checks.rows, notRun: live.notRun } };
  const input = classifierInput({ record, asked, items: c.items, byItem: c.byItem, proposals });
  const r = asked.length || proposals ? await classify(rt, conv.id, input) : { answer: null, costUsd: null, called: false };
  const gated = labelsOf(r.answer, { asked: asked.map((x) => x.ref), turns: new Set(c.byTurn.values()), proposals });
  const build = rt.config.build ?? {};
  const report = pruned({
    schema: 'postbox-telemetry-2',
    id: newId('rep'),
    postbox: { version: build.version ?? null, commit: build.commit ?? null },
    recording: { started: conv.recording.since, ended: conv.recording.on ? Date.now() : (conv.recording.stoppedAt ?? Date.now()), history: c.history },
    ...a,
    gaps: [...a.gaps, ...checks.threw, ...facts.gaps],
    checks: { found: checks.rows, notRun: live.notRun },
    labels: gated.labels,
    proposed: gated.proposed,
  });
  const problems = finalCheck(report, vocabOf(rt));
  if (problems.length)
    throw httpError(422, `Postbox couldn’t make the report: ${problems.length} fields failed its final check (${problems.slice(0, 5).join(', ')}).`);
  const draft = {
    report,
    leftOut: [],
    local: Object.fromEntries(c.local),
    unlabeled: gated.unlabeled,
    labeled: asked.length,
    costUsd: r.costUsd,
    called: r.called,
    at: Date.now(),
  };
  folder(rt, conv.id, 'drafts');
  write(join(dir, 'drafts', `${report.id}.json`), JSON.stringify(draft));
  return { id: report.id };
}

/** A draft, as it was made. */
export function readDraft(rt, convId, id) {
  if (!/^rep_[A-Za-z0-9]{1,16}$/.test(String(id))) throw httpError(404, 'There’s no such report.');
  try {
    return JSON.parse(readFileSync(join(folder(rt, convId), 'drafts', `${id}.json`), 'utf8'));
  } catch {
    throw httpError(404, 'That report isn’t there any more: its recording may have been deleted.');
  }
}

/**
 * What the Telemetry view shows of a draft: the room’s summary, every line of the bytes with whether it’s left out, and
 * the hash of what would be saved. A line left out is the value on it taken out; nothing else changes (R18).
 * @param {any} rt @param {string} convId @param {string} id
 */
export function draftView(rt, convId, id) {
  const draft = readDraft(rt, convId, id);
  const all = jsonLines(draft.report).text.split('\n');
  const { text, hash, report } = bytesOf(draft);
  const r = report.room ?? {};
  return {
    id,
    lines: all.map((line, i) => ({ n: i + 1, line, out: (draft.leftOut ?? []).includes(i + 1) })),
    bytes: text,
    hash,
    summary: [
      ['Agents', r.agents ?? 0],
      ['Turns', r.turns ?? 0],
      ['Your messages', r.personMessages ?? 0],
      ['Reactions', (report.reactions ?? []).length],
      ['Check findings', (report.checks?.found ?? []).length],
      ['Checks not run', (report.checks?.notRun ?? []).length],
      ['Labels', `${(report.labels ?? []).filter((l) => !l.label).length} of ${(report.labels ?? []).length} (the rest unlabeled)`],
      ['Gaps in the record', (report.gaps ?? []).length],
    ],
  };
}
