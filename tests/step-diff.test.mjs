// An edit’s change on its step (server/step-diff.mjs), and where a step falls in its reply’s words (server/runtime.mjs,
// a turn’s activity), which the live view draws from (app/js/activity-live.mjs).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { createCodexMapper } from '../server/adapters/codex.mjs';
import { HarnessEvents } from '../server/harness-events.mjs';
import { Runtime } from '../server/runtime.mjs';
import { stepDiff } from '../server/step-diff.mjs';
import { Store } from '../server/store.mjs';
import { STEP_TEXT } from '../shared/limits.mjs';

test('an Edit’s change is the lines it replaced and the lines it wrote, without the lines they share', () => {
  const d = stepDiff('Edit', { file_path: 'calc.py', old_string: 'def add(a, b):\n    return a - b\n', new_string: 'def add(a, b):\n    return a + b\n' });
  assert.deepEqual(d, { added: 1, deleted: 1, diff: '-    return a - b\n+    return a + b' });
});

test('a Write adds every line; MultiEdit adds up its edits; a call that changes nothing has no diff', () => {
  assert.deepEqual(stepDiff('Write', { file_path: 'n.md', content: 'a\nb\n' }), { added: 2, deleted: 0, diff: '+a\n+b' });
  const multi = stepDiff('MultiEdit', {
    edits: [
      { old_string: 'x', new_string: 'y' },
      { old_string: 'p', new_string: 'q\nr' },
    ],
  });
  assert.deepEqual([multi.added, multi.deleted], [3, 2]);
  assert.deepEqual(stepDiff('Bash', { command: 'ls' }), {});
  assert.deepEqual(stepDiff('Edit', { old_string: 'same', new_string: 'same' }), {});
});

test('a long edit’s diff shows its first whole lines, each cut short, within the step’s bound', () => {
  const short = stepDiff('Write', { content: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') });
  assert.deepEqual([short.added, short.diff?.split('\n').length], [50, 8], 'at most eight lines');
  const long = stepDiff('Write', { content: Array.from({ length: 50 }, (_, i) => `${i}${'x'.repeat(300)}`).join('\n') });
  const lines = long.diff?.split('\n') ?? [];
  assert.ok(lines.length >= 3 && (long.diff?.length ?? 0) <= STEP_TEXT.output, long.diff);
  assert.ok(
    lines.every((l) => l.length <= 121 && l.endsWith('…')),
    'each line whole, cut and marked',
  );
});

/** A runtime whose one agent runs `script` through the contract, held at `hold` until the test lets it go. */
function scripted(/** @type {(emit: any, hold: () => Promise<void>) => Promise<void>} */ script) {
  const store = new Store(null);
  let go = () => {};
  let waiting = false;
  const held = new Promise((r) => {
    go = () => r(undefined);
  });
  const adapter = {
    name: 'mock',
    async folderFor() {
      return null;
    },
    async deliver(/** @type {any} */ _se, /** @type {any} */ _m, /** @type {any} */ ctx) {
      await script(new HarnessEvents(ctx).event, () => {
        waiting = true;
        return held;
      });
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'dev' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const wait = async (/** @type {() => boolean} */ ok) => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  };
  return {
    reply: () => store.items(t.id).find((x) => x.kind === 'agent'),
    async held() {
      rt.sendMessage(t.id, { text: 'Go.' });
      await wait(() => waiting);
    },
    async ended() {
      go();
      await wait(() => !rt.turns.size);
    },
  };
}

const edit = { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' };

test('a step of the agent’s own keeps where it fell in the reply’s words, and an edit’s change, while its turn runs', async () => {
  const run = scripted(async (emit, hold) => {
    emit({ kind: 'text', text: 'Reading first.' });
    emit({ kind: 'tool_call', id: 'e1', name: 'Edit', input: edit, final: true });
    emit({ kind: 'tool_result', id: 'e1', text: 'ok' });
    emit({ kind: 'text', text: 'Done.' });
    await hold();
  });
  await run.held();
  const step = run.reply().activity.steps.find((/** @type {any} */ s) => s.id === 'e1');
  assert.equal(step.at, 'Reading first.'.length, 'after the words before it');
  assert.deepEqual([step.added, step.deleted, step.diff], [1, 1, '-a\n+b']);
  await run.ended();
});

test('a finished turn keeps what its record shows of each step, not the live view’s input, output and diff', async () => {
  const thought = 'Why it fails. '.repeat(200).trim();
  const run = scripted(async (emit, hold) => {
    emit({ kind: 'thinking', text: thought, block: 'th1' });
    emit({ kind: 'thinking_end', block: 'th1' });
    emit({ kind: 'tool_call', id: 'e1', name: 'Edit', input: edit, final: true });
    emit({ kind: 'tool_result', id: 'e1', text: 'ok' });
    emit({ kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'false' }, final: true });
    emit({ kind: 'tool_result', id: 'b1', text: 'it failed', isError: true });
    emit({ kind: 'text', text: 'Done.' });
    await hold();
  });
  await run.held();
  const live = run.reply().activity.steps;
  assert.equal(live.find((/** @type {any} */ s) => s.kind === 'thought').detail.length, thought.length, 'whole while it runs');
  await run.ended();
  const kept = run.reply().activity.steps;
  for (const s of kept) for (const k of ['input', 'output', 'diff', 'at', 'part']) assert.equal(s[k], undefined, `${s.label}: no ${k}`);
  const by = Object.fromEntries(kept.map((/** @type {any} */ s) => [s.id ?? s.kind, s]));
  assert.deepEqual([by.e1.label, by.e1.state, by.e1.added, by.e1.deleted], ['Edited a.txt', 'done', 1, 1], 'its label, state and counts');
  assert.equal(by.b1.state, 'failed');
  assert.equal(kept.find((/** @type {any} */ s) => s.kind === 'thought').detail.length, STEP_TEXT.detail, 'a thought as long as other detail');
});

// Recorded turns (tests/fixtures/), replayed through each adapter’s mapper into the contract: a Codex fileChange says
// each file’s change as a unified diff, which its step shows; Antigravity’s edit_file and write_file say only the path.
const recorded = (/** @type {string} */ path) =>
  readFileSync(new URL(`fixtures/${path}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
/** A turn’s context that keeps its steps, the newest of each id last. */
function stepsCtx() {
  /** @type {Map<string, any>} */
  const steps = new Map();
  const ctx = new Proxy(
    { activity: (/** @type {any} */ a) => steps.set(a.id, { ...steps.get(a.id), ...a }) },
    { get: (t, k) => (k in t ? t[/** @type {'activity'} */ (k)] : () => {}) },
  );
  return { ctx, steps };
}

test('a Codex turn’s file changes show their diff and counts on their steps, from the patch its stream carries', () => {
  const { ctx, steps } = stepsCtx();
  const m = createCodexMapper(ctx, { read: () => null });
  for (const e of recorded('codex-app-server/ledger-edits')) m.push(e);
  const edits = [...steps.values()].filter((s) => /^(Edited|Wrote|Created)/.test(s.label));
  const by = Object.fromEntries(edits.map((s) => [s.label.split(' ').at(-1), s]));
  assert.deepEqual(Object.keys(by).sort(), ['NOTES.md', 'calc.py'], edits.map((s) => s.label).join(', '));
  assert.deepEqual([by['calc.py'].added, by['calc.py'].deleted, by['calc.py'].diff], [1, 1, '-    return a - b\n+    return a + b']);
  assert.deepEqual([by['NOTES.md'].added, by['NOTES.md'].deleted, by['NOTES.md'].diff], [1, 0, '+Fixed add.']);
});

test('an Antigravity turn’s edits carry no change in its stream, only the path, so their steps show none', () => {
  const lines = recorded('antigravity-cli/ledger-edits');
  const edits = lines.map((e) => e.step_update).filter((s) => s?.tool_name === 'edit_file' || s?.tool_name === 'write_file');
  assert.equal(edits.length, 4, 'two edits, each started and done');
  for (const s of edits) assert.deepEqual(Object.keys(s.tool_info), ['name', 'parameters'], 'no output');
  for (const s of edits) assert.deepEqual(Object.keys(s.tool_info.parameters), ['Path'], 'and the path alone');
  const { ctx, steps } = stepsCtx();
  const m = createAgyMapper(ctx, { now: () => 1000 });
  for (const e of lines) m.push(e);
  const shown = [...steps.values()].filter((s) => /calc\.py|TODO\.md/.test(s.label) && !/^Read/.test(s.label));
  assert.equal(shown.length, 2, shown.map((s) => s.label).join(', '));
  for (const s of shown) assert.equal(s.diff, undefined, `${s.label}: nothing to show`);
});
