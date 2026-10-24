// The telemetry gate (designs/telemetry-persona.md, R16, R18; acceptance 5 and 15): every string in a report is Postbox’s
// vocabulary, a ref it issued, or the report’s own id, so a canary has nowhere to go in any encoding; and Leave out
// always gives valid JSON that passes the final check. Each test here fails without the guard it names.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifierInput } from '../server/telemetry-classify.mjs';
import { vocabOf } from '../server/telemetry-report.mjs';
import { setLeftOut } from '../server/telemetry-save.mjs';
import { finalCheck, labelsOf } from '../shared/telemetry.mjs';
import { jsonLines, leaveOut } from '../shared/telemetry-bytes.mjs';
import { CANARIES, flaggedRoom, GOOD, report } from './telemetry-fixture.mjs';

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** The key in each encoding the spec names, and the other canaries as they are. */
function encodings(key = CANARIES.key) {
  const b64 = Buffer.from(key).toString('base64');
  return {
    plain: key,
    base64: b64,
    'split base64': b64.slice(0, 12),
    hex: Buffer.from(key).toString('hex'),
    'look-alike letters': key.replace(/A/g, 'А').replace(/K/g, 'К'),
    'zero-width spaces': key.split('').join('​'),
    'spelled out': key
      .split('')
      .map((ch) => (/\d/.test(ch) ? DIGITS[Number(ch)] : ch))
      .join(' '),
    path: CANARIES.path,
    function: CANARIES.fn,
    email: CANARIES.email,
    repo: CANARIES.repo,
    phrase: CANARIES.phrase,
  };
}

/** Every path to a string in a value, as [path, setter]. */
function stringFields(v, path = []) {
  if (typeof v === 'string') return [path];
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => stringFields(x, [...path, Array.isArray(v) ? Number(k) : k]));
}
const set = (obj, path, value) => {
  const out = structuredClone(obj);
  path.slice(0, -1).reduce((o, k) => o[k], out)[path.at(-1)] = value;
  return out;
};

test('acceptance 5: a canary in any encoding, in any string field, fails the final check, which names the field and not the value', async () => {
  const f = await flaggedRoom();
  const { draft } = await report(f);
  const vocab = vocabOf(f.rt, draft);
  assert.deepEqual(finalCheck(draft.report, vocab), []);
  const fields = stringFields(draft.report);
  assert.ok(fields.length > 30, 'the report has string fields to try');
  for (const [how, value] of Object.entries(encodings()))
    for (const path of fields) {
      const problems = finalCheck(set(draft.report, path, value), vocab);
      assert.ok(problems.length, `${how} in ${path.join('.')} passed`);
      assert.ok(problems.every((p) => !p.includes(value)));
    }
  f.stop();
});

test('acceptance 5: a classifier that answers with a canary in any encoding gets each label refused, and the report holds none', async () => {
  for (const [how, value] of Object.entries(encodings())) {
    for (const field of ['mast', 'area', 'attribution', 'confidence', 'turn']) {
      const f = await flaggedRoom({
        answer: (p) => ({ labels: [...p.matchAll(/<item for="([cr]\d+)">/g)].map((m) => ({ on: m[1], ...GOOD, [field]: value })) }),
      });
      const { draft } = await report(f);
      assert.ok(
        draft.report.labels.every((l) => l.label === 'unlabeled' && l.reason === 'rejected'),
        `${how} as ${field}`,
      );
      assert.ok(!jsonLines(draft.report).text.includes(value));
      f.stop();
    }
  }
});

test('R16 guard: a ref is looked up in the set the report issued; one that only looks like a ref is refused', async () => {
  const f = await flaggedRoom();
  const { draft } = await report(f);
  const vocab = vocabOf(f.rt, draft);
  assert.deepEqual(finalCheck(draft.report, vocab), []);
  assert.ok(finalCheck(set(draft.report, ['reactions', 0, 'on'], 'i999'), vocab).includes('reactions[0].on'));
  assert.ok(finalCheck(set(draft.report, ['turns', 0, 'ref'], 't77'), vocab).includes('turns[0].ref'));
  // A turn ref issued for the report still isn’t an item ref.
  assert.ok(finalCheck(set(draft.report, ['reactions', 0, 'on'], 't1'), vocab).length);
  f.stop();
});

test('R16 guard: the version and commit are this build’s, so a hex canary can’t pass as a commit', async () => {
  const f = await flaggedRoom();
  const { draft } = await report(f);
  const hex = Buffer.from(CANARIES.key).toString('hex').slice(0, 7);
  assert.deepEqual(finalCheck(set(draft.report, ['postbox', 'commit'], hex), vocabOf(f.rt, draft)), ['postbox.commit']);
  assert.deepEqual(finalCheck(set(draft.report, ['postbox', 'version'], '9.9.9'), vocabOf(f.rt, draft)), ['postbox.version']);
  f.stop();
});

test('R12 guard: every number in a report is a bucket, but for issue numbers and the entropy', async () => {
  const f = await flaggedRoom();
  const { draft } = await report(f);
  const numbers = [];
  const walk = (v, k) => {
    if (typeof v === 'number') numbers.push(k);
    else if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v)) walk(x, Array.isArray(v) ? k : kk);
  };
  walk(draft.report, '');
  assert.ok(
    numbers.every((k) => k === 'issue' || k === 'initiativeEntropy'),
    numbers.join(', '),
  );
  // An exact count where a bucket belongs is refused.
  assert.ok(finalCheck(set(draft.report, ['turns', 0, 'tokensIn'], 123), vocabOf(f.rt, draft)).includes('turns[0].tokensIn'));
  f.stop();
});

test('R16 guard: a label’s earliest decisive turn must be one of the refs its finding names', () => {
  const asked = [{ ref: 'r1', refs: ['i3', 'i4'] }];
  const ok = labelsOf({ labels: [{ on: 'r1', ...GOOD, turn: 'i4' }] }, { asked, sent: new Set(['r1']), turns: new Set(['t1', 't2']) });
  assert.equal(ok.labels[0].turn, 'i4');
  const elsewhere = labelsOf({ labels: [{ on: 'r1', ...GOOD, turn: 't2' }] }, { asked, sent: new Set(['r1']), turns: new Set(['t1', 't2']) });
  assert.deepEqual(elsewhere.labels[0], { on: 'r1', label: 'unlabeled', reason: 'rejected' });
  const extra = labelsOf({ labels: [{ on: 'r1', ...GOOD, note: 'hi' }] }, { asked, sent: new Set(['r1']), turns: new Set() });
  assert.equal(extra.labels[0].reason, 'rejected');
});

test('acceptance 15: Leave out on any field or list item gives valid JSON that passes the final check; open and close lines have no toggle', async () => {
  const f = await flaggedRoom();
  const { id, draft } = await report(f);
  const vocab = vocabOf(f.rt, draft);
  const { text, fixed } = jsonLines(draft.report);
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const opensOrCloses = /^\s*(?:"[^"]+": )?[[{]$/.test(line) || /^\s*[\]}],?$/.test(line);
    if (opensOrCloses) assert.ok(fixed.has(i), `line ${i + 1} (${line}) has a toggle`);
    if (fixed.has(i)) continue;
    const out = leaveOut(draft.report, [i + 1]);
    const bytes = jsonLines(out).text;
    assert.deepEqual(JSON.parse(bytes), out, `line ${i + 1}`);
    assert.deepEqual(finalCheck(out, vocab), [], `line ${i + 1}`);
    assert.ok(!bytes.split('\n').includes(line) || lines.filter((l) => l === line).length > 1, `line ${i + 1} is still there`);
  }
  // The schema and id say what the report is: no toggle, and the server refuses one.
  const idLine = lines.findIndex((l) => l.includes('"id": "rep_'));
  assert.ok(fixed.has(idLine));
  assert.throws(() => setLeftOut(f.rt, f.t.id, id, { line: idLine + 1, out: true }), /opens or closes|says what it is/);
  assert.throws(() => setLeftOut(f.rt, f.t.id, id, { line: 1, out: true }), /opens or closes/);
  f.stop();
});

test('review 4 and 5: secrets are trimmed before an item is clipped, and the newest 60 refs are all labeled', () => {
  const key = `sk-ant-api03-${'Zq7x'.repeat(12)}`;
  const items = [{ id: 'a', kind: 'agent', text: `${'filler '.repeat(84)}${key}` }];
  const input = classifierInput({ record: {}, asked: [{ ref: 'r1', item: 'i1' }], items, byItem: new Map([['a', 'i1']]) });
  assert.ok(!input.includes('sk-ant'), 'no fragment of the key');
  const asked = Array.from({ length: 70 }, (_, i) => ({ ref: `r${i + 1}`, refs: [] }));
  const sent = new Set(asked.slice(-60).map((a) => a.ref));
  const out = labelsOf({ labels: asked.map((a) => ({ on: a.ref, ...GOOD })) }, { asked, sent, turns: new Set() });
  assert.equal(out.labels.filter((l) => !l.label).length, 60);
  assert.equal(out.labels[9].reason, 'over-budget');
  assert.equal(out.labels[10].mast, GOOD.mast);
});

test('should-fix: the gate itself caps labels at 60, proposals at 10 and a finding’s refs at 5, and issue numbers are integers', async () => {
  const f = await flaggedRoom();
  const { draft } = await report(f);
  const vocab = vocabOf(f.rt, { ...draft, uat: true });
  const turn = draft.refs.find((r) => r.startsWith('t'));
  const item = draft.refs.find((r) => r.startsWith('i'));
  const label = { on: draft.report.labels[0].on, ...GOOD };
  assert.ok(finalCheck({ ...draft.report, labels: Array(61).fill(label) }, vocab).includes('labels (more than 60)'));
  assert.ok(finalCheck({ ...draft.report, proposed: Array(11).fill({ ...GOOD, turn }) }, vocab).includes('proposed'));
  const found = draft.report.checks.found[0];
  assert.ok(finalCheck(set(draft.report, ['checks', 'found', 0], { ...found, refs: Array(6).fill(item) }), vocab).includes('checks.found[0].refs'));
  assert.ok(finalCheck(set(draft.report, ['checks', 'found', 0], { ...found, issue: 0.123456789012 }), vocab).includes('checks.found[0].issue'));
  f.stop();
});
