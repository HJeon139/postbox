// Leaving lines out of a telemetry report, and saving it (designs/telemetry-persona.md, R18–R20). Postbox applies Leave
// out to the bytes itself, re-runs the final check and shows the new hash; Save writes exactly the bytes whose hash you
// were shown to telemetry/<conversation id>/reports/<id>/report.json in the data folder, then run.json and findings.json, derived from it
// by fixed templates over its enums, so every string in them is Postbox’s. Nothing goes over the network.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { finalCheck } from '../shared/telemetry.mjs';
import { jsonLines } from '../shared/telemetry-bytes.mjs';
import { FLAG } from '../shared/telemetry-vocab.mjs';
import { httpError } from './helpers.mjs';
import { CHECKS } from './room-checks.mjs';
import { convOf, recFolder, reportFolder, telemetryRoot, write } from './telemetry.mjs';
import { bytesOf, draftView, readDraft, vocabOf } from './telemetry-report.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** Leave out a line of the bytes, or put it back: the line’s number in the report as it was made. */
export function setLeftOut(rt, threadId, id, { line, out }) {
  const conv = convOf(rt, threadId);
  const draft = readDraft(rt, conv.id, id);
  if (draft.saved) throw httpError(409, 'This report is saved already.');
  const n = Number(line);
  const shown = jsonLines(draft.report);
  const lines = shown.text.split('\n').length;
  if (!Number.isInteger(n) || n < 1 || n > lines) throw httpError(422, `The report has lines 1 to ${lines}.`);
  if (shown.fixed.has(n - 1))
    throw httpError(422, 'That line only opens or closes a part of the report, or says what it is. Leave out the lines in it instead.');
  draft.leftOut = out ? [...new Set([...(draft.leftOut ?? []), n])] : (draft.leftOut ?? []).filter((x) => x !== n);
  const problems = finalCheck(bytesOf(draft).report, vocabOf(rt, draft));
  if (problems.length) throw httpError(422, `Leaving that out fails the final check (${problems.slice(0, 3).join(', ')}).`);
  write(join(recFolder(rt, conv.id, 'drafts'), `${id}.json`), JSON.stringify(draft));
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
  const problems = finalCheck(report, vocabOf(rt, draft));
  if (problems.length) throw httpError(422, `The report fails the final check (${problems.slice(0, 3).join(', ')}).`);
  const run = runOf(report);
  const findings = { scenario: 'A live room', day: report.recording?.day ?? null, findings: findingsOf(report), timeline: [] };
  // The same check on what’s derived from it: every string in them is one of the report’s, or a template over them (R19).
  const derived = [...derivedProblems(run, report, 'run.json'), ...derivedProblems(findings, report, 'findings.json')];
  if (derived.length) throw httpError(422, `A file derived from the report fails the final check (${derived.slice(0, 3).join(', ')}).`);
  const dir = reportFolder(rt, conv.id, id);
  write(join(dir, 'report.json'), text);
  write(join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  write(join(dir, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`);
  // What File issue checks the bytes against later: their hash, the refs issued, and the build they were saved by.
  write(join(dir, 'meta.json'), JSON.stringify({ hash: now, refs: draft.refs ?? [], uat: draft.uat === true }));
  draft.saved = { at: Date.now(), hash: now };
  write(join(recFolder(rt, conv.id, 'drafts'), `${id}.json`), JSON.stringify(draft));
  return { ok: true, id, hash: now };
}

/**
 * A saved report’s bytes, read back from report.json: what File issue sends from. They must be the bytes saved, by the
 * hash recorded at Save, and pass the final check again, so a report.json edited on disk is never sent (R19).
 */
export function savedBytes(rt, convId, id) {
  if (!convId || !/^rep_[A-Za-z0-9]{1,16}$/.test(String(id))) throw httpError(404, 'There’s no such report.');
  const dir = join(telemetryRoot(rt) ?? '', convId, 'reports', id);
  if (!existsSync(join(dir, 'report.json'))) throw httpError(404, 'That report isn’t saved.');
  const text = readFileSync(join(dir, 'report.json'), 'utf8');
  const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : null;
  if (!meta || meta.hash !== sha(text)) throw httpError(409, 'This report’s file changed after it was saved, so Postbox won’t send it. Delete it.');
  /** @type {any} */
  let report = null;
  try {
    report = JSON.parse(text);
  } catch {
    throw httpError(409, 'This report’s file doesn’t parse. Delete it.');
  }
  // The build is the running one, never a file’s word for it: meta.json sits beside report.json, as easy to edit.
  const problems = finalCheck(report, { checkIds: CHECKS.map((c) => c.id), build: rt.config.build ?? {}, refs: meta.refs ?? [], uat: meta.uat === true });
  if (problems.length)
    throw httpError(
      422,
      `This report fails the final check (${problems.slice(0, 3).join(', ')}), so Postbox won’t send it. One saved by another version of Postbox can be deleted, not filed.`,
    );
  return { text, hash: sha(text), report };
}

/** Strings in a file derived from the report that aren’t the report’s own or a fixed template’s, as paths. */
export function derivedProblems(obj, report, name) {
  const ok = new Set(['A live room', 'live', 'check', 'flag']);
  const walk = (v) => (typeof v === 'string' ? ok.add(v) : v && typeof v === 'object' ? Object.values(v).forEach(walk) : null);
  walk(report);
  for (const f of findingsOf(report)) for (const s of [f.title, f.key]) ok.add(s);
  const out = [];
  const check = (v, path) => {
    if (typeof v === 'string' && !ok.has(v)) out.push(path);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) check(x, `${path}.${k}`);
  };
  check(obj, name);
  return out;
}

/** The reports saved from this conversation, newest first. */
export function savedReports(rt, threadId) {
  const conv = convOf(rt, threadId);
  const root = telemetryRoot(rt);
  const dir = conv && root ? join(root, conv.id, 'reports') : null;
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => existsSync(join(dir, id, 'report.json')))
    .map((id) => {
      let saved;
      try {
        saved = savedBytes(rt, conv.id, id);
      } catch (e) {
        // A report that no longer checks out is listed, so you can delete it, with nothing to file.
        return { id, hash: '', at: statSync(join(dir, id, 'report.json')).mtimeMs, broken: e.message, findings: [] };
      }
      const { hash, report } = saved;
      return { id, hash, at: statSync(join(dir, id, 'report.json')).mtimeMs, findings: findingsOf(report).map((f) => ({ key: f.key, title: f.title })) };
    })
    .sort((a, b) => b.at - a.at);
}

/** Discards a report not yet saved: its draft goes, and nothing was written but the draft (R18). */
export function discardDraft(rt, threadId, id) {
  const conv = convOf(rt, threadId);
  const draft = readDraft(rt, conv.id, id);
  if (draft.saved) throw httpError(409, 'This report is saved already. Delete it from the saved reports instead.');
  rmSync(join(recFolder(rt, conv.id, 'drafts'), `${id}.json`), { force: true });
  return { ok: true };
}

/** Deletes a saved report. */
export function deleteReport(rt, threadId, id) {
  const conv = convOf(rt, threadId);
  // No check first: a report that no longer checks out is exactly the one to delete.
  const dir = conv && /^rep_[A-Za-z0-9]{1,16}$/.test(String(id)) ? join(telemetryRoot(rt) ?? '', conv.id, 'reports', id) : null;
  if (!dir || !existsSync(dir)) throw httpError(404, 'There’s no such report.');
  rmSync(dir, { recursive: true, force: true });
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
    // A report holds durations and costs in buckets only (R12), so a live run has no exact minutes or spend.
    minutes: null,
    cost: { agents: null, tester: 0, kiroCredits: null },
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
