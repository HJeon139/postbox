// A harness that writes one block of the reply at a time streams it exactly as before #1293’s change (#1293). Holding
// another block’s words back applies only to a block its adapter marks open, as Codex marks a message still streaming,
// and only while that block is mid-sentence: no recorded turn interleaves, so every one reaches the reply with the same
// words on the same line of its stream, with nothing held and nothing late, Codex’s included.
//
// single-stream-reply-golden.json is what main gave at 724874bc, before the change, for every recorded turn in
// tests/fixtures (claude-code, kiro-cli, antigravity-cli, codex-app-server): the reply’s text written as each line of
// the stream was pushed, kept by line number where a line wrote any.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { createCodexMapper } from '../server/adapters/codex.mjs';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('single-stream-reply-golden.json', import.meta.url), 'utf8'));
/** @type {Record<string, (ctx: any, now: () => number) => any>} */
const MAPPERS = {
  'claude-code': (ctx, now) => createStreamMapper(ctx, { now }),
  'kiro-cli': (ctx, now) => createKiroMapper(ctx, { now }),
  'antigravity-cli': (ctx, now) => createAgyMapper(ctx, { now }),
  'codex-app-server': (ctx) => createCodexMapper(ctx),
};
const FIXTURES = Object.keys(MAPPERS).flatMap((dir) =>
  readdirSync(new URL(`fixtures/${dir}`, import.meta.url))
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => `${dir}/${n}`),
);

/**
 * The reply’s text written as each line of a recorded turn is pushed, with the clock 10 ms on per line, by line number
 * where a line wrote any. @param {string} name
 */
function replay(name) {
  const [dir] = name.split('/');
  let t = 0;
  let got = '';
  const calls = { text: (/** @type {string} */ d) => (got += d), persona: { permissionMode: 'auto' }, state: {} };
  // Every other callback the mappers make (activity, status, …) is a no-op here, and there’s no abort signal: only the
  // reply’s text is compared.
  const ctx = new Proxy(calls, {
    get(o, k) {
      if (k in o) return o[/** @type {keyof typeof o} */ (k)];
      return k === 'signal' ? undefined : () => {};
    },
  });
  const m = MAPPERS[dir](ctx, () => t);
  /** @type {Record<string, string>} */
  const wrote = {};
  let n = 0;
  for (const line of readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // not a stream line
    }
    t += 10;
    got = '';
    m.push(e);
    if (got) wrote[n] = got;
    n++;
  }
  return wrote;
}

test('#1293: every recorded turn is in the golden', () => {
  assert.deepEqual(FIXTURES.toSorted(), Object.keys(GOLDEN).toSorted());
});

for (const name of FIXTURES)
  test(`#1293: ${name} reaches the reply line for line as on main`, () => {
    assert.deepEqual(replay(name), GOLDEN[name]);
  });
