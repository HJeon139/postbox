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

test('a live frame’s output still wins over the blob, as what the conversation showed', () => {
  const step = dryCall({ live: rec.live, blob: () => 'not this' });
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
    const escape = `../${'./'.repeat(30)}.`;
    assert.equal(escape.length, 64);
    assert.equal(data.blob?.(escape), null);
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
