// What #239's reviews found, each with a test that fails without its fix (designs/telemetry-persona.md, R11, R16, R19).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KEEP_MS, lostOf, recordingOff, startRecording, sweep, telemetryRoot, watchTelemetry } from '../server/telemetry.mjs';
import { issuePreview } from '../server/telemetry-file.mjs';
import { draftView, vocabOf } from '../server/telemetry-report.mjs';
import { telemetryRoute } from '../server/telemetry-routes.mjs';
import { deleteReport, derivedProblems, findingsOf, runOf, savedReports, saveReport, TEMPLATES } from '../server/telemetry-save.mjs';
import { finalCheck } from '../shared/telemetry.mjs';
import { CANARIES, flaggedRoom, labelEach, report, settle, setup } from './telemetry-fixture.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
async function saved(f) {
  const { id } = await report(f);
  saveReport(f.rt, f.t.id, id, { hash: draftView(f.rt, f.t.id, id).hash });
  return { id, dir: join(f.data, 'telemetry', f.t.id, 'reports', id) };
}
/** Edits a saved report.json and keeps its meta.json’s hash in step, as an agent with a shell could. */
function tamper(dir, edit, metaEdit = (m) => m) {
  const text = edit(readFileSync(join(dir, 'report.json'), 'utf8'));
  writeFileSync(join(dir, 'report.json'), text);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...metaEdit(meta), hash: sha(text) }));
}

test('round 2, 1: the sweep takes only conversation folders', async () => {
  const f = await flaggedRoom();
  const other = join(f.data, 'telemetry', 'notes');
  mkdirSync(other);
  sweep(f.rt);
  assert.ok(existsSync(other), 'a folder that isn’t a conversation’s is left alone');
  f.stop();
});

test('round 2, 2: File issue checks the running build and strict refs, not meta.json’s word for them', async () => {
  const f = await flaggedRoom();
  const { id, dir } = await saved(f);
  const key = savedReports(f.rt, f.t.id)[0].findings[0].key;
  tamper(
    dir,
    (t) => t.replace('"version": "0.21.0"', `"version": "${CANARIES.key}"`),
    (m) => ({ ...m, build: { version: CANARIES.key, commit: 'abc1234' } }),
  );
  assert.throws(() => issuePreview(f.rt, f.t.id, id, key), /final check \(postbox\.version/);
  const g = await flaggedRoom();
  const s2 = await saved(g);
  tamper(
    s2.dir,
    (t) => t.replace(/"on": "r1"/g, '"on": "r1234567"'),
    (m) => ({ ...m, refs: [...m.refs, 'r1234567'] }),
  );
  assert.throws(() => issuePreview(g.rt, g.t.id, s2.id, 'flag-r1'), /isn’t in the saved report|final check/);
  f.stop();
  g.stop();
});

test('round 2, 3: a sweep that can’t delete leaves a gap, and never stops Postbox at start', async () => {
  const f = await flaggedRoom();
  const streams = join(f.data, 'telemetry', f.t.id, 'recording', 'streams');
  const old = (Date.now() - KEEP_MS - 864e5) / 1000;
  writeFileSync(join(streams, 'old.jsonl'), '{}\n');
  utimesSync(join(streams, 'old.jsonl'), old, old);
  chmodSync(streams, 0o500);
  try {
    assert.doesNotThrow(() => sweep(f.rt));
    f.stop();
    assert.doesNotThrow(() => watchTelemetry(f.rt)());
    assert.equal(lostOf(f.rt).sweep, true);
  } finally {
    chmodSync(streams, 0o700);
  }
  const { draft } = await report(f);
  assert.ok(draft.report.gaps.some((g) => g.kind === 'sweep'));
});

test('round 2, 5: drafts and events older than 30 days age out while a fresh stream stays', async () => {
  const f = await flaggedRoom();
  await report(f);
  const rec = join(f.data, 'telemetry', f.t.id, 'recording');
  const old = (Date.now() - KEEP_MS - 864e5) / 1000;
  const [draft] = readdirSync(join(rec, 'drafts'));
  utimesSync(join(rec, 'drafts', draft), old, old);
  const events = join(rec, 'events.jsonl');
  writeFileSync(events, `${JSON.stringify({ seq: 1, type: 'item.add', t: Date.now() - KEEP_MS - 864e5 })}\n${readFileSync(events, 'utf8')}`);
  const before = readFileSync(events, 'utf8').split('\n').filter(Boolean).length;
  sweep(f.rt);
  assert.ok(!existsSync(join(rec, 'drafts', draft)));
  assert.equal(readFileSync(events, 'utf8').split('\n').filter(Boolean).length, before - 1);
  assert.ok(existsSync(join(rec, 'turns.jsonl')), 'the recording stays');
  f.stop();
});

test('round 2, 5: run.json and findings.json are checked at Save: a string that isn’t the report’s fails', async () => {
  const f = await flaggedRoom();
  const { draft } = await report(f);
  const findings = { scenario: 'A live room', findings: findingsOf(draft.report) };
  assert.deepEqual(derivedProblems(runOf(draft.report), draft.report, 'run.json'), []);
  assert.deepEqual(derivedProblems(findings, draft.report, 'findings.json'), []);
  findings.findings[0].title = `Live room: ${CANARIES.phrase}`;
  assert.deepEqual(derivedProblems(findings, draft.report, 'findings.json'), ['findings.json.findings.0.title']);
  // A slot holds only a check id or an enum: a slug that looks like one doesn’t pass.
  for (const title of ['Live room: check zorvex-quillmorph', 'Live room: FM-9.9 in checks', 'Live room: none in zorvex']) {
    findings.findings[0].title = title;
    assert.deepEqual(derivedProblems(findings, draft.report, 'findings.json'), ['findings.json.findings.0.title'], title);
  }
  f.stop();
});

test('should-fix: a broken saved report can be deleted; a stray file in drafts/ doesn’t break the view; entropy is capped', async () => {
  const f = await flaggedRoom();
  const { id, dir } = await saved(f);
  writeFileSync(join(dir, 'report.json'), 'not json');
  assert.ok(savedReports(f.rt, f.t.id)[0].broken);
  deleteReport(f.rt, f.t.id, id);
  assert.ok(!existsSync(dir));
  writeFileSync(join(f.data, 'telemetry', f.t.id, 'recording', 'drafts', '.DS_Store'), 'junk');
  assert.equal((await telemetryRoute(f.rt, `/api/threads/${f.t.id}/telemetry`, 'GET', null)).status, 200);
  const { draft } = await report(f);
  const room = (e) => ({ ...draft.report, room: { ...draft.report.room, initiativeEntropy: e } });
  assert.deepEqual(finalCheck(room(1.5), vocabOf(f.rt, draft)), []);
  assert.ok(finalCheck(room(123456.7), vocabOf(f.rt, draft)).includes('room.initiativeEntropy'));
  f.stop();
});

test('round 3, 1: a finding’s issue is its check’s own, or the report fails the final check', async () => {
  const f = await flaggedRoom();
  const { draft } = await report(f);
  const found = draft.report.checks.found[0];
  assert.ok(Number.isInteger(found.issue), 'the fixture’s finding has its check’s issue');
  const withIssue = (n) => ({ ...draft.report, checks: { ...draft.report.checks, found: [{ ...found, issue: n }] } });
  assert.deepEqual(finalCheck(withIssue(found.issue), vocabOf(f.rt, draft)), []);
  assert.ok(finalCheck(withIssue(4242424), vocabOf(f.rt, draft)).includes('checks.found[0].issue'));
  f.stop();
});

test('round 3, 2: Record this room makes the telemetry folder’s parents, as for a first ~/.postbox', async () => {
  const f = setup();
  f.rt.config.telemetryRoot = join(f.data, 'never', 'made', 'telemetry');
  assert.doesNotThrow(() => startRecording(f.rt, f.t.id));
  assert.ok(existsSync(join(f.data, 'never', 'made', 'telemetry', f.t.id, 'recording')));
  f.stop();
});

test('round 3, 4: Save runs the check on what it derives; a template that let room text in is refused', async () => {
  const f = await flaggedRoom();
  const { id } = await report(f);
  const real = TEMPLATES.findingsOf;
  TEMPLATES.findingsOf = (r) => real(r).map((x) => ({ ...x, title: `Live room: ${CANARIES.phrase}` }));
  try {
    assert.throws(() => saveReport(f.rt, f.t.id, id, { hash: draftView(f.rt, f.t.id, id).hash }), /derived from the report fails/);
  } finally {
    TEMPLATES.findingsOf = real;
  }
  assert.ok(!existsSync(join(f.data, 'telemetry', f.t.id, 'reports', id)));
  f.stop();
});

test('round 3, 4: a sweep that throws as a whole is caught at start, and a later clean one clears the gap', async () => {
  const f = setup();
  f.stop();
  const file = join(f.data, 'not-a-folder');
  writeFileSync(file, 'x');
  f.rt.config.telemetryRoot = file;
  assert.doesNotThrow(() => watchTelemetry(f.rt)());
  assert.equal(lostOf(f.rt).sweep, true);
  f.rt.config.telemetryRoot = join(f.data, 'telemetry');
  watchTelemetry(f.rt)();
  assert.equal(lostOf(f.rt).sweep, false);
});

test('round 4, 3: a room whose turn failed saves and files: the failed-turn row has no issue field', async () => {
  const f = setup({ record: true, answer: labelEach() });
  f.adapter.next.push(async () => {
    throw new Error('boom');
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha go' });
  await settle(f.rt);
  const { id, draft } = await report(f);
  const row = draft.report.checks.found.find((k) => k.check === 'failed-turn');
  assert.ok(row && !('issue' in row));
  saveReport(f.rt, f.t.id, id, { hash: draftView(f.rt, f.t.id, id).hash });
  const key = savedReports(f.rt, f.t.id)[0].findings.find((x) => x.key === 'failed-turn').key;
  assert.match(issuePreview(f.rt, f.t.id, id, key).text, /Live room: /);
  f.stop();
});

test('ruling: a clone on its own data/ can’t record and says to move its data first; a moved clone records into ~/.postbox', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pb-clone-rule-'));
  const clone = join(base, 'postbox', 'data');
  const home = join(base, 'home', '.postbox');
  mkdirSync(clone, { recursive: true });
  const f = setup();
  delete f.rt.config.telemetryRoot;
  f.rt.config.cloneData = clone;
  f.rt.store.dir = clone;
  assert.match(recordingOff(f.rt), /--move-data first/);
  assert.equal(telemetryRoot(f.rt), null);
  assert.throws(() => startRecording(f.rt, f.t.id), /--move-data first/);
  assert.ok(!existsSync(join(clone, 'telemetry')), 'nothing written in data/');
  // After --move-data: data/ is a link to the person’s Postbox folder, which the store now runs from.
  rmSync(clone, { recursive: true });
  mkdirSync(home, { recursive: true });
  symlinkSync(home, clone);
  for (const dir of [home, clone]) {
    f.rt.store.dir = dir;
    assert.equal(recordingOff(f.rt), null);
    assert.equal(realpathSync(join(telemetryRoot(f.rt), '..')), realpathSync(home));
  }
  startRecording(f.rt, f.t.id);
  assert.ok(existsSync(join(home, 'telemetry', f.t.id, 'recording')));
  f.stop();
  // The store appends its log to the folder this test pointed it at; it finishes before the folder goes (#266).
  await f.rt.store.flush();
  rmSync(base, { recursive: true, force: true });
});
