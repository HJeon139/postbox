// Leaving lines out of a telemetry report, and saving it (designs/telemetry-persona.md, R18–R20). Postbox applies Leave
// out to the bytes itself, re-runs the final check and shows the new hash; Save writes exactly the bytes whose hash you
// were shown to telemetry/reports/<id>/report.json in the data folder, then run.json and findings.json, derived from it
// by fixed templates over its enums, so every string in them is Postbox’s. Nothing goes over the network.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { finalCheck } from '../shared/telemetry.mjs';
import { jsonLines } from '../shared/telemetry-bytes.mjs';
import { FLAG } from '../shared/telemetry-vocab.mjs';
import { httpError } from './helpers.mjs';
import { convOf, folder, reportIndex, telemetryRoot, write, writeIndex } from './telemetry.mjs';
import { bytesOf, draftView, readDraft, vocabOf } from './telemetry-report.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** Leave out a line of the bytes, or put it back: the line’s number in the report as it was made. */
export function setLeftOut(rt, threadId, id, { line, out }) {
  const conv = convOf(rt, threadId);
  const draft = readDraft(rt, conv.id, id);
  if (draft.saved) throw httpError(409, 'This report is saved already.');
  const n = Number(line);
  const lines = jsonLines(draft.report).text.split('\n').length;
  if (!Number.isInteger(n) || n < 1 || n > lines) throw httpError(422, `The report has lines 1 to ${lines}.`);
  draft.leftOut = out ? [...new Set([...(draft.leftOut ?? []), n])] : (draft.leftOut ?? []).filter((x) => x !== n);
  const problems = finalCheck(bytesOf(draft).report, vocabOf(rt));
  if (problems.length) throw httpError(422, `Leaving that out fails the final check (${problems.slice(0, 3).join(', ')}).`);
  write(join(folder(rt, conv.id), 'drafts', `${id}.json`), JSON.stringify(draft));
  return draftView(rt, conv.id, id);
}

/**
 * Save: writes the bytes you were shown, refusing if they’re not the ones whose hash you saw (R18, R19).
 * @param {any} rt @param {string} threadId @param {string} id @param {{ hash?: string }} body
 */
export function saveReport(rt, threadId, id, { hash } = {}) {
  const conv = convOf(rt, threadId);
  const draft = readDraft(rt, conv.id, id);
  const { report, text, hash: now } = bytesOf(draft);
  if (hash !== now) throw httpError(409, 'The report changed since you looked at it. Look at it again, then save.');
  const problems = finalCheck(report, vocabOf(rt));
  if (problems.length) throw httpError(422, `The report fails the final check (${problems.slice(0, 3).join(', ')}).`);
  const dir = folder(rt, 'reports', id);
  write(join(dir, 'report.json'), text);
  write(join(dir, 'run.json'), `${JSON.stringify(runOf(report), null, 2)}\n`);
  write(
    join(dir, 'findings.json'),
    `${JSON.stringify({ scenario: 'A live room', started: report.recording?.started ?? null, findings: findingsOf(report), timeline: [] }, null, 2)}\n`,
  );
  writeIndex(rt, { ...reportIndex(rt), [id]: conv.id });
  draft.saved = { at: Date.now(), hash: now };
  write(join(folder(rt, conv.id), 'drafts', `${id}.json`), JSON.stringify(draft));
  return { ok: true, id, hash: now };
}

/** A saved report’s bytes and their hash, read back from report.json: what File issue sends from. */
export function savedBytes(rt, id) {
  if (!/^rep_[A-Za-z0-9]{1,16}$/.test(String(id))) throw httpError(404, 'There’s no such report.');
  const file = join(folder(rt, 'reports'), id, 'report.json');
  if (!existsSync(file)) throw httpError(404, 'That report isn’t saved.');
  const text = readFileSync(file, 'utf8');
  return { text, hash: sha(text), report: JSON.parse(text) };
}

/** The reports saved from this conversation, newest first. */
export function savedReports(rt, threadId) {
  const conv = convOf(rt, threadId);
  const root = telemetryRoot(rt);
  if (!conv || !root || !existsSync(join(root, 'reports'))) return [];
  const index = reportIndex(rt);
  return readdirSync(join(root, 'reports'))
    .filter((id) => index[id] === conv.id)
    .map((id) => {
      const { hash, report } = savedBytes(rt, id);
      return { id, hash, at: report.recording?.ended ?? 0, findings: findingsOf(report).map((f) => ({ key: f.key, title: f.title })) };
    })
    .sort((a, b) => b.at - a.at);
}

/** Deletes a saved report. */
export function deleteReport(rt, threadId, id) {
  const conv = convOf(rt, threadId);
  const index = reportIndex(rt);
  if (index[id] !== conv?.id) throw httpError(404, 'That report wasn’t saved from this conversation.');
  rmSync(join(folder(rt, 'reports'), id), { recursive: true, force: true });
  const { [id]: _gone, ...rest } = index;
  writeIndex(rt, rest);
  return { ok: true };
}

/** The model the most agents ran on, and their effort. */
function modelOf(report) {
  const n = new Map();
  for (const a of report.agents ?? []) n.set(a.model, (n.get(a.model) ?? 0) + 1);
  const model = [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { model, effort: report.agents?.find((a) => a.model === model)?.effort ?? null };
}

/** run.json for a live report (R20): a run with no steps, so the per-step discovery curve leaves it out. */
export function runOf(report) {
  const usd = (report.turns ?? []).reduce((a, t) => a + (t.costUsd ?? 0), 0);
  return {
    run: report.id,
    scenario: 'live',
    title: 'A live room',
    kind: 'live',
    branch: null,
    commit: report.postbox?.commit ?? null,
    agents: modelOf(report),
    testerModel: null,
    steps: 0,
    stepCap: 0,
    startPhase: 1,
    minutes: Math.round(((report.recording?.ended ?? 0) - (report.recording?.started ?? 0)) / 60000),
    cost: { agents: Math.round(usd * 100) / 100, tester: 0, kiroCredits: null },
    coverage: null,
  };
}

/** A label as a finding carries it, or none. */
const telemetryOf = (l) => (l && !l.label ? { mast: l.mast, area: l.area, attribution: l.attribution, confidence: l.confidence } : undefined);

/**
 * The report’s findings in the UAT’s format (R19, R20): each check finding and each 🚩, with its label. Every string is a
 * template over the report’s enums, such as “Live room: FM-2.6 in agent-contract”. Proposed failures are never findings.
 * @param {any} report
 */
export function findingsOf(report) {
  const labelOf = (ref) => (report.labels ?? []).find((l) => l.on === ref);
  const title = (what, l) => `Live room: ${l && !l.label ? `${l.mast} in ${l.area}` : what}`;
  const checks = (report.checks?.found ?? []).map((k) => {
    const l = labelOf(k.ref);
    return {
      source: 'check',
      check: k.check,
      issue: k.issue ?? null,
      key: k.check,
      ref: k.ref,
      title: title(`check ${k.check}`, l),
      step: null,
      telemetry: telemetryOf(l),
    };
  });
  const flags = (report.reactions ?? [])
    .filter((r) => r.emoji === FLAG)
    .map((r) => {
      const l = labelOf(r.ref);
      return { source: 'flag', check: null, issue: null, key: `flag-${r.ref}`, ref: r.ref, title: title('a flag', l), step: null, telemetry: telemetryOf(l) };
    });
  return [...checks, ...flags];
}
