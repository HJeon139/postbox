// What #239's reviews found, each with a test that fails without its fix (designs/telemetry-persona.md, R11, R16, R19).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { postboxHome } from '../server/home.mjs';
import { KEEP_MS, lostOf, sweep, telemetryRoot, watchTelemetry } from '../server/telemetry.mjs';
import { issuePreview } from '../server/telemetry-file.mjs';
import { draftView, vocabOf } from '../server/telemetry-report.mjs';
import { telemetryRoute } from '../server/telemetry-routes.mjs';
import { deleteReport, derivedProblems, findingsOf, runOf, savedReports, saveReport } from '../server/telemetry-save.mjs';
import { finalCheck } from '../shared/telemetry.mjs';
import { CANARIES, flaggedRoom, report } from './telemetry-fixture.mjs';

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

test('round 2, 1: a clone’s telemetry has a folder of its own, and the sweep takes only conversation folders', async () => {
  const clone = fileURLToPath(new URL('../data', import.meta.url));
  const root = telemetryRoot({ config: {}, store: { dir: clone } });
  assert.notEqual(root, join(postboxHome(), 'telemetry'));
  assert.ok(root.startsWith(postboxHome()));
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
