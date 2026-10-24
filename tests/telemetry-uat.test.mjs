// Telemetry and the UAT (designs/telemetry-persona.md, R13, R18, R20, U3, U5; acceptance 13, 16, 17): proposals only in
// a UAT run, a draft that survives a reload, live reports in the stats, and the checks and triggers that watch telemetry.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChecks } from '../server/room-checks.mjs';
import { TELEMETRY_CHECK_IDS } from '../server/room-checks-telemetry.mjs';
import { draftView } from '../server/telemetry-report.mjs';
import { telemetryRoute } from '../server/telemetry-routes.mjs';
import { saveReport } from '../server/telemetry-save.mjs';
import { readRuns } from '../tools/uat/runs.mjs';
import { recurrence, report as statsReport } from '../tools/uat/stats.mjs';
import { TELEMETRY_TRIGGERS } from '../tools/uat/telemetry-triggers.mjs';
import { verdictOf } from '../tools/uat/verdicts.mjs';
import { CANARIES, flaggedRoom, GOOD, labelEach, report } from './telemetry-fixture.mjs';

const proposing =
  (n, extra = []) =>
  (p) => ({ ...labelEach()(p), proposed: [...Array.from({ length: n }, () => ({ ...GOOD, turn: 't1' })), ...extra] });

test('acceptance 16: in a live room every proposal is rejected; in a UAT run ten land, the eleventh and an unissued turn don’t', async () => {
  const live = await flaggedRoom({ answer: proposing(3) });
  assert.equal((await report(live)).draft.report.proposed, undefined);
  live.stop();
  process.env.POSTBOX_TELEMETRY_PROPOSALS = '1';
  try {
    const uat = await flaggedRoom({ answer: proposing(11, [{ ...GOOD, turn: 't99' }]) });
    const { draft } = await report(uat);
    assert.equal(draft.report.proposed.length, 10);
    assert.ok(draft.report.proposed.every((p) => p.turn === 't1'));
    uat.stop();
    const odd = await flaggedRoom({ answer: proposing(0, [{ ...GOOD, turn: 't99' }]) });
    assert.equal((await report(odd)).draft.report.proposed, undefined);
    odd.stop();
  } finally {
    delete process.env.POSTBOX_TELEMETRY_PROPOSALS;
  }
});

test('acceptance 17: the Telemetry view reopens an unsaved draft with its bytes and Leave out choices, and calls the classifier once', async () => {
  const f = await flaggedRoom();
  const { id } = await report(f);
  const line = draftView(f.rt, f.t.id, id).lines.find((l) => l.toggle);
  await telemetryRoute(f.rt, `/api/threads/${f.t.id}/telemetry/reports/${id}/leave-out`, 'POST', { line: line.n, out: true });
  const before = draftView(f.rt, f.t.id, id);
  const open = (await telemetryRoute(f.rt, `/api/threads/${f.t.id}/telemetry`, 'GET', null))?.body;
  assert.equal(open.draft, id);
  assert.deepEqual(draftView(f.rt, f.t.id, open.draft), before);
  assert.equal(f.prompts.length, 1);
  await telemetryRoute(f.rt, `/api/threads/${f.t.id}/telemetry/reports/${id}/discard`, 'POST', {});
  assert.equal((await telemetryRoute(f.rt, `/api/threads/${f.t.id}/telemetry`, 'GET', null))?.body.draft, null);
  f.stop();
});

test('acceptance 13: live reports count toward recurrence only, and a flag’s classifier “confirmed” is no verdict', async () => {
  const f = await flaggedRoom({ answer: labelEach({ ...GOOD, attribution: 'confirmed' }) });
  const { id } = await report(f);
  saveReport(f.rt, f.t.id, id, { hash: draftView(f.rt, f.t.id, id).hash });
  const { runs } = readRuns([join(f.data, 'telemetry')]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, 'live');
  const flag = runs[0].findings.find((x) => x.source === 'flag');
  assert.equal(flag.telemetry.attribution, 'confirmed');
  assert.equal(verdictOf(flag), null);
  const check = runs[0].findings.find((x) => x.source === 'check' && Number.isInteger(x.issue));
  assert.equal(verdictOf(check), 'duplicate');
  assert.ok(recurrence(runs).some((r) => r.issue === check.issue));
  assert.ok(statsReport(runs).includes('All runs: 0 runs'));
  f.stop();
});

/** A run’s facts with a saved report and what telemetry showed, for the U3 checks. */
async function uatFacts() {
  const f = await flaggedRoom();
  const { id } = await report(f);
  const { hash } = draftView(f.rt, f.t.id, id);
  saveReport(f.rt, f.t.id, id, { hash });
  const text = readFileSync(join(f.data, 'telemetry', f.t.id, 'reports', id, 'report.json'), 'utf8');
  const facts = {
    state: f.store.state,
    threads: [f.t.id],
    streams: [],
    telemetry: {
      canaries: { key: CANARIES.key },
      reports: [{ id, text, derived: ['', ''] }],
      drafts: [],
      shown: { saved: [hash], issues: [], copied: [], opened: [] },
      flags: [{ key: 'x', item: f.reply.id }],
      modes: [{ path: 'a', dir: true, mode: 0o700 }],
      turns: [],
      expected: [],
      workspace: f.folder,
    },
  };
  return { f, facts, id };
}
const fired = (facts) => runChecks(facts, { only: TELEMETRY_CHECK_IDS }).map((x) => x.check);

test('U3: the telemetry checks pass on a clean run, and each fires on its own defect', async () => {
  const { f, facts } = await uatFacts();
  assert.deepEqual(fired(facts), []);
  const leak = structuredClone(facts);
  leak.telemetry.reports[0].text = leak.telemetry.reports[0].text.replace(
    'postbox-telemetry-2',
    `postbox-telemetry-2 ${Buffer.from(CANARIES.key).toString('base64')}`,
  );
  assert.deepEqual(fired(leak), ['telemetry-leak', 'telemetry-bytes-mismatch']);
  const seen = structuredClone(facts);
  seen.streams = [{ handle: 'alpha', events: [{ type: 'user', message: { content: '[Postbox] Recording since 10:02.' } }] }];
  assert.deepEqual(fired(seen), ['recording-visible']);
  const moved = structuredClone(facts);
  moved.telemetry.flags = [{ key: 'x', item: 'it_elsewhere' }];
  assert.deepEqual(fired(moved), ['flag-misplaced']);
  const open = structuredClone(facts);
  open.telemetry.modes.push({ path: 'a/report.json', dir: false, mode: 0o644 });
  assert.deepEqual(fired(open), ['telemetry-at-rest']);
  const missed = structuredClone(facts);
  missed.telemetry.expected = ['stale-answer-accepted'];
  assert.deepEqual(fired(missed), ['telemetry-missed-finding']);
  assert.deepEqual(fired({ ...facts, telemetry: undefined }), []);
  f.stop();
});

test('U1: the file-fallback trigger needs the shown text copied and the new-issue page opened', () => {
  const text = 'Live room: a flag\n\nbody';
  const shown = {
    issues: [{ text, hash: createHash('sha256').update(text).digest('hex') }],
    copied: [{ text, at: 1 }],
    opened: [{ url: 'https://github.com/HJeon139/postbox/issues/new', at: 2 }],
  };
  assert.equal(TELEMETRY_TRIGGERS['telemetry-file-fallback'].run({ telemetry: { shown } }).length, 1);
  assert.equal(TELEMETRY_TRIGGERS['telemetry-file-fallback'].run({ telemetry: { shown: { ...shown, opened: [] } } }).length, 0);
});
