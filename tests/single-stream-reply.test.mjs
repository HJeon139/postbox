// A harness that writes one block of the reply at a time streams it exactly as before #1293’s change (#1293). Holding
// another block’s words back applies only to a block its adapter marks open, as Codex marks a message still streaming;
// Claude Code, the Agent SDK, Kiro and Antigravity never do, so each recorded turn reaches the reply with the same words
// on the same line of its stream, with nothing held and nothing late.
//
// single-stream-reply-golden.json is what main gave at 48c6883c, before the change: for each recorded turn, the reply's
// text written as each line of it was pushed. These are the recorded turns whose text changes block mid-sentence before
// a background command (the case a timed hold delayed), one with a block, and one each from Kiro and Antigravity.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('single-stream-reply-golden.json', import.meta.url), 'utf8'));
/** @type {Record<string, (ctx: any, now: () => number) => any>} */
const MAPPERS = {
  'claude-code': (ctx, now) => createStreamMapper(ctx, { now }),
  'kiro-cli': (ctx, now) => createKiroMapper(ctx, { now }),
  'antigravity-cli': (ctx, now) => createAgyMapper(ctx, { now }),
};

/** The reply's text written as each line of a recorded turn is pushed, with the clock 10 ms on per line. @param {string} name */
function replay(name) {
  const [dir] = name.split('/');
  let t = 0;
  let got = '';
  const calls = { text: (/** @type {string} */ d) => (got += d), persona: { permissionMode: 'auto' }, state: {} };
  // Every other callback the mappers make (activity, status, …) is a no-op here: only the reply's text is compared.
  const ctx = new Proxy(calls, { get: (o, k) => (k in o ? o[/** @type {keyof typeof o} */ (k)] : () => {}) });
  const m = MAPPERS[dir](ctx, () => t);
  const per = [];
  for (const line of readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    t += 10;
    got = '';
    m.push(JSON.parse(line));
    per.push(got);
  }
  return per;
}

for (const name of Object.keys(GOLDEN))
  test(`#1293: ${name} reaches the reply line for line as on main`, () => {
    assert.deepEqual(replay(name), GOLDEN[name]);
  });
