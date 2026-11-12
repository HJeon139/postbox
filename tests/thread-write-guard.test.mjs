// Where server code writes a thread (#796, designs/508/601-held-view.md). A write built from the published thread
// overwrites a write of the same thread still held behind a commit, so every write of a thread that exists goes through
// updateThread (server/thread-write.mjs), which starts from store.pending.thread. Every write is placed here by file and
// function, and an updateThread change may not read a published thread: directly (rt.s.threads, state.threads,
// rt.thread(), convOf()), or through a local of its function bound from one, the form the issue's own regex missed. The
// guard reads source text, so a local bound from a local bound from a published read passes, and review reads for it.
// Its deciding reads are pending reads, placed in tests/store-held-guard.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECL, placed, sites, withProbes } from './server-sources-fixture.mjs';

/** Every write of a thread: updateThread, and the two that put a new one. */
const THREAD_WRITES = {
  'conversations.mjs': ['createThread'], // a new thread, through putThread
  'runtime.mjs': ['putThread', 'putThread'], // putThread and its emit, called only by createThread, for a new thread
  'thread-write.mjs': ['updateThread'], // a thread that exists, from store.pending.thread
  'topic-open.mjs': ['startTopic'], // a new topic
};
const THREAD_WRITE = /\bputThread\(|\bemit\(\s*['"`]thread['"`]/;
/** A published read of a thread. */
const PUBLISHED_THREAD = /\.s\.threads\b|\bstate\.threads\b|\b(?:rt|this)\.thread\(|\bconvOf\(/;
/** A local bound in a function: `const t = …` or `for (const t of …)`, with what it's bound from. */
const BIND = /\b(?:const|let|var)\s+(\w+)\s*=([^;]*)|\bfor\s*\(\s*const\s+(\w+)\s+of\s+([^)]*\))/g;

/** The arguments of the call whose `(` is just before `from`, split at its top-level commas. @param {string} text @param {number} from */
function argsAt(text, from) {
  const args = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if ((c === ',' && depth === 0) || depth < 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) break;
  }
  return args;
}

/**
 * The updateThread calls whose change reads a published thread. The change is every argument after the first two; a
 * change that's a function gets the pending thread as its parameter, so a local of the same name isn't read there.
 * @param {string[]} [extra]  probe sources
 */
function publishedBases(extra = []) {
  const CALL = 'updateThread(';
  const out = [];
  for (const [path, text] of withProbes(extra)) {
    const lines = text.split('\n');
    for (let at = text.indexOf(CALL); at >= 0; at = text.indexOf(CALL, at + 1)) {
      const line = text.slice(0, at).split('\n').length - 1;
      if (/^\s*(\/\/|\*|import\b|export\s+function\s+updateThread\b)/.test(lines[line])) continue;
      const change = argsAt(text, at + CALL.length)
        .slice(2)
        .join(',');
      const param = change.match(/^\s*\(?\s*(\w+)\s*\)?\s*=>/)?.[1];
      let decl = line;
      while (decl > 0 && !DECL.test(lines[decl])) decl--;
      const body = lines.slice(decl, line + 1).join('\n'); // its function, up to the call
      const locals = [...body.matchAll(BIND)]
        .filter((m) => PUBLISHED_THREAD.test(m[2] ?? m[4]))
        .map((m) => m[1] ?? m[3])
        .filter((x) => x !== param);
      // The local itself or its spread (`t`, `...t`), not a member that has its name (`x.t`).
      const readsLocal = locals.some((x) => new RegExp(`(?<![\\w$])(?<![^.]\\.)${x}\\b`).test(change));
      if (PUBLISHED_THREAD.test(change) || readsLocal) out.push(`${path}: ${lines[line].trim()}`);
    }
  }
  return out;
}

test('every thread write in server/ is placed, by file and function', () => {
  placed(THREAD_WRITE, THREAD_WRITES, 'the thread writes');
  // The issue's form, and the local copy its regex missed: each is found.
  const probes = [
    'export function zz1(rt, x) { rt.putThread({ ...rt.s.threads[x], hops: 0 }); }',
    'export function zz2(rt, id, queue) {\n  const t = rt.thread(id);\n  rt.putThread({ ...t, queue });\n}',
    "export function zz3(rt, id) { rt.store.emit('thread', { ...rt.s.threads[id], unread: 0 }); }",
  ];
  const found = Object.keys(sites(THREAD_WRITE, probes)).filter((k) => k.startsWith('extra-'));
  assert.deepEqual(found, ['extra-0.mjs', 'extra-1.mjs', 'extra-2.mjs']);
});

test('no updateThread change in server/ reads a published thread, directly or through a local', () => {
  assert.deepEqual(publishedBases(), [], 'build the change from the thread updateThread passes it, never from a published read');
  const probes = [
    'export function zz4(rt, id, q) { updateThread(rt, id, { queue: [...rt.s.threads[id].queue, q] }); }',
    'export function zz5(rt, id, q) {\n  const t = rt.thread(id);\n  updateThread(rt, id, { queue: [...(t.queue ?? []), q] });\n}',
    'export function zz6(rt) {\n  for (const t of Object.values(rt.s.threads)) updateThread(rt, t.id, { ...t, archived: true });\n}',
    'export function zz7(rt, id) {\n  const conv = convOf(rt, id);\n  updateThread(rt, conv.id, { ...conv, recording: null });\n}',
    // The pending thread the change is given, named as a published local is, reads no published thread: not found.
    'export function zz8(rt, id, q) {\n  const t = rt.thread(id);\n  updateThread(rt, t.id, (t) => ({ queue: [...(t.queue ?? []), q] }));\n}',
  ];
  assert.deepEqual(
    publishedBases(probes).map((l) => l.split(':')[0]),
    ['extra-0.mjs', 'extra-1.mjs', 'extra-2.mjs', 'extra-3.mjs'],
  );
});
