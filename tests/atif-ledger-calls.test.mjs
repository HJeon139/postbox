// Each tool call's start time and output from the work ledger (tools/atif-calls.mjs), so a trajectory exported from the
// stored events alone, with no live frames, still says when each call started and what it returned. From the recorded
// dry run in tests/fixtures/atif/dry-run: @dry's one Bash call, `printenv CLAUDE_EFFORT`, which printed `high`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';

const DIR = new URL('fixtures/atif/dry-run/', import.meta.url).pathname;
const rec = readRecording(DIR);
const command = rec.events.find((e) => e.type === 'work.add' && e.data.entry.kind === 'command').data.entry;
const ended = rec.events.find((e) => e.type === 'work.patch' && e.data.id === command.id && e.data.patch.output).data.patch;
const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');

/** @dry's agent step with the call, from these events and live frames, with this blob reader. */
const dryCall = (/** @type {any} */ opts) => {
  const t = trajectories(rec.events, { version: POSTBOX_VERSION, prompts: rec.prompts, ...opts }).find((x) => x.handle === 'dry').trajectory;
  return t.steps.find((s) => s.tool_calls?.some((c) => c.tool_call_id === command.toolUseId));
};

test('the fixture is the call these tests are about', () => {
  assert.equal(command.command, 'printenv CLAUDE_EFFORT');
  assert.equal(ended.output.sha256, sha('high'), 'the ledger names its output by the SHA-256 of what it printed');
  assert.equal(ended.exit, 0);
});

test('a call’s start time is its ledger entry’s, so a turn of many calls still dates each one', () => {
  const step = dryCall({ live: [] });
  assert.equal(step.tool_calls[0].extra.started_at, new Date(command.at).toISOString());
  assert.equal(step.tool_calls[0].extra.exit, 0);
});

test('with no live frames, a call’s output comes from the store’s blob its ledger entry names', () => {
  const step = dryCall({ live: [], blob: (/** @type {string} */ h) => (h === ended.output.sha256 ? 'high' : null) });
  assert.deepEqual(step.observation, { results: [{ source_call_id: command.toolUseId, content: 'high' }] });
});

test('#1757 the stored output wins over a live frame’s capped text, which stays as what the conversation showed', () => {
  // A step’s output is cut to its last 400 characters (shared/limits.mjs, STEP_TEXT), so the blob is the whole of it.
  const step = dryCall({ live: rec.live, blob: (/** @type {string} */ h) => (h === ended.output.sha256 ? 'the whole output\nhigh' : null) });
  assert.deepEqual(step.observation.results, [{ source_call_id: command.toolUseId, content: 'the whole output\nhigh' }]);
  assert.equal(step.tool_calls[0].extra.display_output, 'high', 'the live frame’s text, as the conversation showed it');
});

test('#1757 with no stored output to read, a live frame’s text is the result, as before', () => {
  const step = dryCall({ live: rec.live, blob: () => null });
  assert.deepEqual(step.observation.results, [{ source_call_id: command.toolUseId, content: 'high' }]);
});

test('a missing blob gives no result rather than an empty one', () => {
  assert.equal(dryCall({ live: [], blob: () => null }).observation, undefined);
});

test('an output over 16,384 characters is cut there, and the result says how much it held', () => {
  const step = dryCall({ live: [], blob: () => 'x'.repeat(20_000) });
  const { content } = step.observation.results[0];
  assert.ok(content.startsWith('x'.repeat(16_384)));
  assert.match(content, /\[cut by the exporter: 16,384 of 20,000 characters\]$/);
});

test('reading a data folder reads its blobs, checked against their hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atif-blobs-'));
  try {
    copyFileSync(join(DIR, 'events.jsonl'), join(dir, 'events-1.jsonl'));
    const h = ended.output.sha256;
    mkdirSync(join(dir, 'blobs', h.slice(0, 2)), { recursive: true });
    writeFileSync(join(dir, 'blobs', h.slice(0, 2), h.slice(2)), 'high');
    const data = readRecording(dir);
    assert.equal(data.blob?.(h), 'high');
    assert.equal(data.blob?.('0'.repeat(64)), null, 'a blob the folder lacks');
    // A name that isn't a SHA-256 is refused before any path is built: this one would resolve to the data folder itself.
    const outside = `../${'./'.repeat(30)}.`;
    assert.equal(outside.length, 64);
    assert.equal(data.blob?.(outside), null);
    mkdirSync(join(dir, 'blobs', 'aa', 'a'.repeat(62)), { recursive: true });
    assert.equal(data.blob?.('a'.repeat(64)), null, 'a folder where a blob should be');
    writeFileSync(join(dir, 'blobs', h.slice(0, 2), h.slice(2)), 'damaged');
    assert.equal(readRecording(dir).blob?.(h), null, 'bytes that no longer match their hash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an output too large to read is noted by its size, and its blob isn’t read', () => {
  const big = rec.events.map((e) =>
    e.type === 'work.patch' && e.data.patch.output?.sha256 === ended.output.sha256
      ? { ...e, data: { ...e.data, patch: { ...e.data.patch, output: { ...e.data.patch.output, size: 100 * 1024 * 1024 } } } }
      : e,
  );
  let read = 0;
  const t = trajectories(big, {
    version: POSTBOX_VERSION,
    prompts: rec.prompts,
    live: [],
    blob: () => {
      read += 1;
      return 'high';
    },
  }).find((x) => x.handle === 'dry').trajectory;
  const step = t.steps.find((s) => s.tool_calls?.some((c) => c.tool_call_id === command.toolUseId));
  assert.deepEqual(step.observation.results, [{ source_call_id: command.toolUseId, content: '[output too large to read: 104,857,600 bytes]' }]);
  assert.equal(read, 0);
});

/** The recording's events with the call's ending ledger patch changed by `edit`. @param {(p: any) => any} edit */
const withEnded = (edit) =>
  rec.events.map((e) =>
    e.type === 'work.patch' && e.data.patch.output?.sha256 === ended.output.sha256 ? { ...e, data: { ...e.data, patch: edit(e.data.patch) } } : e,
  );
/** @dry's call step from these events, with the live frames and blob reader given. */
const callIn = (/** @type {any[]} */ events, /** @type {any} */ opts) =>
  trajectories(events, { version: POSTBOX_VERSION, prompts: rec.prompts, ...opts })
    .find((x) => x.handle === 'dry')
    .trajectory.steps.find((s) => s.tool_calls?.some((c) => c.tool_call_id === command.toolUseId));
const theBlob = (/** @type {string} */ h) => (h === ended.output.sha256 ? 'the whole output\nhigh' : null);

test('#1757 a failed call’s note is its detail, not its output, and the stored output is still its result', () => {
  const failed = rec.live.map((f) =>
    f.step?.id === command.toolUseId && 'output' in f.step ? { ...f, step: { id: f.step.id, state: 'failed', detail: 'Exit code 1' } } : f,
  );
  const step = dryCall({ live: failed, blob: theBlob });
  assert.deepEqual(step.observation.results, [{ source_call_id: command.toolUseId, content: 'the whole output\nhigh' }]);
  assert.equal(step.tool_calls[0].extra.display_detail, 'Exit code 1');
  assert.equal(step.tool_calls[0].extra.display_output, undefined, 'a note isn’t output');
  // With nothing stored, the note is the result, as before #1757.
  const bare = dryCall({ live: failed, blob: () => null });
  assert.deepEqual(bare.observation.results, [{ source_call_id: command.toolUseId, content: 'Exit code 1' }]);
});

test('#1757 a background command’s stored output is the job’s, seen later, so the call’s own text stays its result', () => {
  const step = callIn(
    withEnded((p) => ({ ...p, endedInBackground: true })),
    { live: rec.live, blob: theBlob },
  );
  assert.deepEqual(step.observation.results, [{ source_call_id: command.toolUseId, content: 'high' }]);
  assert.equal(step.tool_calls[0].extra.ended_in_background, true);
});

test('#1757 a stored output the ledger kept only the end of says so; one too large to read is noted over the live text', () => {
  const cut = callIn(
    withEnded((p) => ({ ...p, output: { ...p.output, cut: true } })),
    { live: rec.live, blob: theBlob },
  );
  assert.match(cut.observation.results[0].content, /^\[the work ledger kept only its last \d+ bytes\]\nthe whole output/);
  const big = callIn(
    withEnded((p) => ({ ...p, output: { ...p.output, size: 100 * 1024 * 1024 } })),
    { live: rec.live, blob: theBlob },
  );
  assert.deepEqual(big.observation.results, [{ source_call_id: command.toolUseId, content: '[output too large to read: 104,857,600 bytes]' }]);
  assert.equal(big.tool_calls[0].extra.display_output, 'high', 'the live text is still what the conversation showed');
});

test('#1752 a command that printed nothing has an empty result, not none, so it reads apart from a missing one', () => {
  const step = callIn(
    withEnded((p) => ({ ...p, output: { size: 0 } })),
    { live: [], blob: () => null },
  );
  assert.deepEqual(step.observation.results, [{ source_call_id: command.toolUseId, content: '' }]);
});
