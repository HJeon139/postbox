// A telemetry report, on request (designs/telemetry-persona.md, R2, R3, R8, R12–R16, R18): the record of the room, the
// checks a live room can run, one classifier call, the gate, and the bytes Postbox builds from what passed. The draft
// stays in the recording, local, until you save it (server/telemetry-save.mjs); the Telemetry view shows its bytes.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { finalCheck, labelsOf } from '../shared/telemetry.mjs';
import { blurred, jsonLines, leaveOut, pruned } from '../shared/telemetry-bytes.mjs';
import { FLAG } from '../shared/telemetry-vocab.mjs';
import { httpError } from './helpers.mjs';
import { CHECKS, liveChecks } from './room-checks.mjs';
import { newId } from './store.mjs';
import { convOf, readLines, recFolder, write } from './telemetry.mjs';
import { BEFORE, boundedInput, classify } from './telemetry-classify.mjs';
import { collect, tierA } from './telemetry-record.mjs';

const BY_BACKEND = { 'kiro-cli': 'kiroStreams', 'antigravity-cli': 'agyStreams', codex: 'codexStreams' };

/** What the final check needs: Postbox’s check ids, this build’s version and commit, and the refs this report issued. */
export const vocabOf = (rt, draft) => ({ checkIds: CHECKS.map((c) => c.id), build: rt.config.build ?? {}, refs: draft?.refs ?? [], uat: draft?.uat === true });

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
 * The refs to label, oldest first, each with the item it’s about and the refs its finding names, one of which a label’s
 * earliest decisive turn must be: a check’s own, or the flagged item and the four before it (R16). named adds the turns
 * those items came from, so the record sent can be trimmed to them (R3).
 */
function askedOf(c, itemRefs, rows, reactions) {
  const turnOf = new Map(c.items.filter((it) => c.byItem.has(it.id) && c.byTurn.has(it.turnId)).map((it) => [c.byItem.get(it.id), c.byTurn.get(it.turnId)]));
  const withTurns = (refs) => [...new Set([...refs, ...refs.map((r) => turnOf.get(r)).filter(Boolean)])];
  return [
    ...rows.map((k) => {
      // A check that cites more than five offers its earliest five (R16), by ordinal: refs number the room in order.
      const refs = [...k.refs].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).slice(0, BEFORE + 1);
      return { ref: k.ref, item: refs.find((x) => x.startsWith('i')) ?? null, refs, named: withTurns(refs) };
    }),
    ...reactions
      .filter((r) => r.emoji === FLAG)
      .map((r) => {
        const at = itemRefs.indexOf(r.on);
        const refs = itemRefs.slice(Math.max(0, at - BEFORE), at + 1);
        return { ref: r.ref, item: r.on, refs, named: withTurns(refs) };
      }),
  ];
}

/** Why the classifier had no say in a label, if it didn’t: no classifier, a failed call, or refs over budget (R3). */
function outcomeOf(r, sent, asked) {
  const failed = !sent.size ? null : !r.called ? 'no-classifier' : r.answer ? null : 'failed-call';
  return { failed, why: [...(failed ? [failed] : []), ...(sent.size < asked.length ? ['over-budget'] : [])] };
}

/**
 * Makes a report: the record, the checks, the classifier’s labels through the gate, and the bytes. Returns the draft’s
 * id; the Telemetry view reads it with draftView.
 * @param {any} rt @param {string} threadId @param {{ history?: boolean }} [opts]
 */
export async function makeReport(rt, threadId, { history = false } = {}) {
  const conv = convOf(rt, threadId);
  if (!conv?.recording) throw httpError(409, 'This conversation has no recording. Choose Record this room first.');
  const dir = recFolder(rt, conv.id);
  const c = collect(rt, conv, dir, { history: history === true });
  const facts = liveFacts(rt, c);
  const live = liveChecks(facts);
  const checks = checksOf(c, live);
  const a = tierA(rt, c);
  const itemRefs = c.items.map((it) => c.byItem.get(it.id)).filter(Boolean);
  const asked = askedOf(c, itemRefs, checks.rows, a.reactions);
  const proposals = process.env.POSTBOX_TELEMETRY_PROPOSALS === '1';
  const record = { ...a, checks: { found: checks.rows, notRun: live.notRun } };
  const { input, sent } = boundedInput({ record, asked, items: c.items, byItem: c.byItem, proposals });
  const r = sent.size || proposals ? await classify(rt, conv.id, input) : { answer: null, costUsd: null, called: false };
  const { failed, why } = outcomeOf(r, sent, asked);
  const turns = new Set(c.byTurn.values());
  const gated = labelsOf(r.answer, { asked, sent, turns, failed, proposals });
  const build = rt.config.build ?? {};
  const ended = conv.recording.on ? Date.now() : (conv.recording.stoppedAt ?? Date.now());
  const report = blurred(
    pruned({
      schema: 'postbox-telemetry-2',
      id: newId('rep'),
      postbox: { version: build.version ?? null, commit: build.commit ?? null },
      recording: { day: new Date().toISOString().slice(0, 10), lengthMs: Math.max(0, ended - conv.recording.since), history: c.history },
      classifier: { called: r.called, costUsd: r.costUsd },
      ...a,
      gaps: [...a.gaps, ...checks.threw, ...facts.gaps, ...why.map((reason) => ({ kind: 'classifier', reason }))],
      checks: { found: checks.rows, notRun: live.notRun },
      labels: gated.labels,
      proposed: gated.proposed,
    }),
  );
  const refs = [...itemRefs, ...turns, ...checks.rows.map((k) => k.ref), ...a.reactions.map((x) => x.ref)];
  const problems = finalCheck(report, vocabOf(rt, { refs, uat: proposals }));
  if (problems.length)
    throw httpError(422, `Postbox couldn’t make the report: ${problems.length} fields failed its final check (${problems.slice(0, 5).join(', ')}).`);
  const draft = {
    report,
    leftOut: [],
    local: Object.fromEntries(c.local),
    unlabeled: gated.unlabeled,
    labeled: asked.length,
    refs,
    // What the classifier was sent and answered, local like the rest, so a rejected label can be traced.
    ...{ input, answer: r.answer, costUsd: r.costUsd, called: r.called },
    uat: proposals,
    at: Date.now(),
  };
  write(join(recFolder(rt, conv.id, 'drafts'), `${report.id}.json`), JSON.stringify(draft));
  return { id: report.id };
}

/** A draft, as it was made. */
export function readDraft(rt, convId, id) {
  if (!/^rep_[A-Za-z0-9]{1,16}$/.test(String(id))) throw httpError(404, 'There’s no such report.');
  try {
    return JSON.parse(readFileSync(join(recFolder(rt, convId, 'drafts'), `${id}.json`), 'utf8'));
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
  const shown = jsonLines(draft.report);
  const all = shown.text.split('\n');
  const { text, hash, report } = bytesOf(draft);
  const r = report.room ?? {};
  return {
    id,
    lines: all.map((line, i) => ({ n: i + 1, line, out: (draft.leftOut ?? []).includes(i + 1), toggle: !shown.fixed.has(i) })),
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
