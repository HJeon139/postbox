// #1987: every server call of a turn’s stop names who stopped it. stop() refuses a call without `by`
// (tests/stop-by.test.mjs), but a new caller on a path no test runs would pass the gate and throw in production, inside
// a timer at worst. The typecheck can’t catch it, since callers hold `rt` untyped, so this guard reads the source: each
// `rt.stop(`, `this.stop(` and `stop(rt,` call’s arguments must name `by`, as a key or shorthand. A call that passes
// its options through, or is another object’s stop, is placed in PASSED_THROUGH by file and enclosing function, with
// its reason. The guard reads source text: a spread that carries `by` fails it, and is placed; the word `by` anywhere in
// the arguments, a string’s included, passes it, and review reads for that.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enclosing, withProbes } from './server-sources-fixture.mjs';

/** A call of a turn’s stop: through the runtime, as a method, or of turn-stop.mjs’s stop() itself. */
const STOP_CALL = /\b(?:rt|this)\.stop\(|(?<!function )\bstop\((?:rt|this),/g;

/** file → enclosing function: calls that don’t name `by` themselves. */
const PASSED_THROUGH = {
  'runtime.mjs': ['stop'], // the facade: passes its caller’s options to turn-stop.mjs’s stop(), which checks them
  'narration/narrator.mjs': ['touch'], // the narration worker’s own stop(), not a turn’s
};

/** The text of a call’s arguments, from just after its opening parenthesis. @param {string} text @param {number} from */
function argsAt(text, from) {
  let depth = 1;
  let i = from;
  while (depth && i < text.length) {
    const c = text[i++];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
  }
  return text.slice(from, i - 1);
}

/** Every stop call in the server, and `extra` probe sources: { at: 'file:function', named }. @param {string[]} [extra] */
function stopCalls(extra = []) {
  const out = [];
  for (const [path, text] of withProbes(extra)) {
    const lines = text.split('\n');
    let offset = 0;
    lines.forEach((line, i) => {
      if (!/^\s*(\/\/|\*)/.test(line))
        for (const m of line.matchAll(STOP_CALL)) {
          const args = argsAt(text, offset + /** @type {number} */ (m.index) + m[0].length);
          const fn = enclosing(lines, i);
          out.push({ path, fn, named: /\bby\b/.test(args) });
        }
      offset += line.length + 1;
    });
  }
  return out;
}

/** The calls that neither name `by` nor are placed in PASSED_THROUGH, as 'file:function'. @param {string[]} [extra] */
const missingBy = (extra) =>
  stopCalls(extra)
    .filter((c) => !c.named && !PASSED_THROUGH[/** @type {keyof typeof PASSED_THROUGH} */ (c.path)]?.includes(c.fn))
    .map((c) => `${c.path}:${c.fn}`);

test('#1987 every server stop of a turn names who stopped it', () => {
  const named = stopCalls().filter((c) => c.named).length;
  // A scan that finds nothing proves nothing: today’s callers include Stop, Send now, the run clock, delete and shutdown.
  assert.ok(named >= 10, `only ${named} stop calls that name by found: the pattern has drifted`);
  assert.deepEqual(missingBy(), [], 'name who stopped the turn (by), or place the call in PASSED_THROUGH with its reason');
});

test('#1987 the guard catches a stop without by, and takes one that names it', () => {
  const probe = [
    'function hangs(rt, id) {\n  rt.stop(id, { silent: true });\n}',
    'function quits(rt, id) {\n  rts.rt.stop(id, {\n    by: "hung", why });\n}',
    'function bare(rt, id) {\n  stop(rt, id);\n}',
  ];
  assert.deepEqual(missingBy(probe), ['extra-0.mjs:hangs', 'extra-2.mjs:bare']);
});
