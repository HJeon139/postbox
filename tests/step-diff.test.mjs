// An edit’s change on its step (server/step-diff.mjs), and where a step falls in its reply’s words (server/runtime.mjs,
// a turn’s activity), which the live view draws from (app/js/activity-live.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
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

test('a step of the agent’s own keeps where it fell in the reply’s words, and an edit’s change', async () => {
  const store = new Store(null);
  const adapter = {
    name: 'mock',
    async folderFor() {
      return null;
    },
    async deliver(/** @type {any} */ _se, /** @type {any} */ _m, /** @type {any} */ ctx) {
      const emit = new HarnessEvents(ctx).event;
      emit({ kind: 'text', text: 'Reading first.' });
      emit({ kind: 'tool_call', id: 'e1', name: 'Edit', input: { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' }, final: true });
      emit({ kind: 'tool_result', id: 'e1', text: 'ok' });
      emit({ kind: 'text', text: 'Done.' });
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
  rt.sendMessage(t.id, { text: 'Go.' });
  for (let i = 0; i < 200 && rt.turns.size; i++) await new Promise((r) => setTimeout(r, 5));
  const reply = store.items(t.id).find((x) => x.kind === 'agent');
  const step = reply.activity.steps.find((/** @type {any} */ s) => s.id === 'e1');
  assert.equal(step.at, 'Reading first.'.length, 'after the words before it');
  assert.deepEqual([step.added, step.deleted, step.diff], [1, 1, '-a\n+b']);
});
