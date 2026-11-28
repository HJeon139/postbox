// #585: the Codex conformance probe counts its marker in the rollout Codex saved. The fixture is a real rollout,
// codex-cli 0.167.0: thread/start with a guide, thread/inject_items, then a resume in a new process and another
// injected item, recorded by the probe’s own --record (tests/fixtures/codex-conformance/README.md). Its guide is
// agentGuide’s, with the marker the probe gave it, read back from the fixture.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { savedOnce } from '../tools/conformance/codex-start.mjs';
import { rolloutMarkers, savedMarkers } from '../tools/conformance/rollout.mjs';
import { tempDir } from './temp-dirs.mjs';

const ROLLOUT = readFileSync(new URL('fixtures/codex-conformance/guide-rollout.jsonl', import.meta.url), 'utf8');
const LINES = ROLLOUT.split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const MARKER = ROLLOUT.match(/postbox-conformance-start-[0-9a-f]{12}/)?.[0] ?? '';
/** The developer text that holds the marker: the guide, whole, as the probe gave it. */
const GUIDE = LINES.flatMap((line) => line.payload?.content ?? []).find((part) => part.text.includes(MARKER))?.text ?? '';
/** The rollout with the guide’s line changed by `edit`. @param {(line: any) => any} edit */
const withGuideLine = (edit) =>
  `${LINES.map((line) => JSON.stringify(JSON.stringify(line).includes(MARKER) ? edit(structuredClone(line)) : line)).join('\n')}\n`;

test('the recorded rollout holds a marker and its guide, so the tests below read something', () => {
  assert.ok(MARKER, 'a marker');
  assert.ok(GUIDE.length > 1000, 'the whole guide');
});

test('the recorded rollout holds the guide once, in a developer message', () => {
  assert.deepEqual(rolloutMarkers(ROLLOUT, MARKER, GUIDE), { developer: 1, elsewhere: 0, whole: 1 });
  assert.equal(rolloutMarkers(ROLLOUT, MARKER, `${GUIDE} and the rest`).whole, 0, 'a guide cut short isn’t whole');
});

test('a guide saved twice counts twice, so a resume that adds it again fails', () => {
  const guideLine = ROLLOUT.split('\n').find((l) => l.includes(MARKER));
  assert.deepEqual(rolloutMarkers(`${ROLLOUT}${guideLine}\n`, MARKER), { developer: 2, elsewhere: 0, whole: 0 });
});

test('the marker outside a developer message counts as elsewhere', () => {
  const asUser = withGuideLine((line) => Object.assign(line, { payload: { ...line.payload, role: 'user' } }));
  assert.deepEqual(rolloutMarkers(asUser, MARKER), { developer: 0, elsewhere: 1, whole: 0 });
  assert.deepEqual(rolloutMarkers(`${ROLLOUT}{"cut off ${MARKER}\n`, MARKER), { developer: 1, elsewhere: 1, whole: 0 }, 'a broken line can’t pass');
  const asEvent = withGuideLine((line) => Object.assign(line, { type: 'event_msg' }));
  assert.deepEqual(rolloutMarkers(asEvent, MARKER), { developer: 0, elsewhere: 1, whole: 0 }, 'a developer message outside a response item');
});

test('a rollout without the marker counts nothing', () => {
  assert.deepEqual(rolloutMarkers(ROLLOUT, 'another-marker'), { developer: 0, elsewhere: 0, whole: 0 });
});

test('savedMarkers reads every rollout under sessions, and a CODEX_HOME with none has no files', async () => {
  const home = tempDir('conformance-rollout-');
  assert.deepEqual(await savedMarkers(home, MARKER, GUIDE), { files: 0, developer: 0, elsewhere: 0, whole: 0 });
  const day = join(home, 'sessions', '2026', '11', '27');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-2026-11-27T00-00-00-thr-1.jsonl'), ROLLOUT);
  writeFileSync(join(day, 'notes.txt'), MARKER);
  assert.deepEqual(await savedMarkers(home, MARKER, GUIDE), { files: 1, developer: 1, elsewhere: 0, whole: 1 });
});

test('the start check passes only one file with the whole guide once, in a developer message', () => {
  const once = { files: 1, developer: 1, elsewhere: 0, whole: 1 };
  assert.equal(savedOnce(once), true);
  assert.equal(savedOnce({ files: 0, developer: 0, elsewhere: 0, whole: 0 }), false, 'nothing saved');
  assert.equal(savedOnce({ ...once, developer: 2, whole: 2 }), false, 'saved twice');
  assert.equal(savedOnce({ ...once, developer: 0, elsewhere: 1, whole: 0 }), false, 'saved, but not as the developer’s');
  assert.equal(savedOnce({ ...once, files: 2 }), false, 'a second rollout');
  assert.equal(savedOnce({ ...once, whole: 0 }), false, 'the marker kept, the guide cut short');
});
