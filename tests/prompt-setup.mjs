// The setup the permission prompt tests share (#353, #665): the recorded turn permission-subagent.jsonl, fed through
// the real stream parser into the runtime’s own turn context, the prompts its CLI sent (permission-prompts.json), and
// helpers to post a prompt as whoever holds the turn’s token, run a turn, and read the cards and lines it leaves.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { cards, until } from './requested-setup.mjs';

/** Lets the event loop run, without timers: a test with a fake clock still moves on. */
export const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const PENDING = Symbol('pending');
/**
 * A prompt’s answer, which must have come by now (the event loop let run, no timers): one still held fails by `what`,
 * at once, rather than by the test’s timeout. @template T @param {Promise<T>} asked @param {string} what @returns {Promise<T>}
 */
export async function answerNow(asked, what) {
  /** @type {any} */
  let got = PENDING;
  asked.then(
    (v) => {
      got = { v };
    },
    (e) => {
      got = { e };
    },
  );
  await flush();
  assert.notEqual(got, PENDING, `No answer yet: ${what}`);
  if (Object.hasOwn(got, 'e')) throw got.e;
  return got.v;
}
export const STREAM = readFileSync(new URL('fixtures/claude-code/permission-subagent.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
export const PROMPTS = JSON.parse(readFileSync(new URL('fixtures/claude-code/permission-prompts.json', import.meta.url), 'utf8')).prompts;
/** The index of the line after which the CLI asked: its call’s whole tool_use is in, its result isn’t yet. */
export const askedAfter = (id) => STREAM.findIndex((e) => e.type === 'assistant' && e.message.content.some((b) => b.type === 'tool_use' && b.id === id)) + 1;

/** permission_prompt from whoever holds the running turn’s token: the CLI, or a command the agent ran. */
export function prompt(s, args, signal = null) {
  const se = s.rt.sessionsIn(s.t.id)[0];
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'permission_prompt', arguments: args } };
  return handleMcp(s.rt, se.id, msg, s.rt.turns.get(se.id)?.token ?? null, signal).then((r) => JSON.parse(r.result.content[0].text));
}
/**
 * Runs one turn of the agent’s, with the turn context `c`, and waits for it to end. It waits on the turn itself, not by
 * polling, so `fn` can hold a fake clock; what `fn` throws fails the test.
 */
export async function turn(s, fn, text = 'Write the notes.') {
  /** @type {(e?: unknown) => void} */
  let ran = () => {};
  const done = new Promise((r) => {
    ran = r;
  });
  s.next.push(async (c) => {
    try {
      await fn(c);
      c.text('Done.');
      ran();
    } catch (e) {
      ran(e);
    }
  });
  s.rt.sendMessage(s.t.id, { text });
  const failed = await done;
  if (failed) throw failed;
  await until(() => !s.rt.turns.size);
}
export const refusals = (s) => s.store.items(s.t.id).filter((i) => i.kind === 'system' && i.variant === 'prompt-refused');
export const openCard = async (s) => {
  await until(() => cards(s).some((c) => c.status === 'open'));
  return cards(s).find((c) => c.status === 'open');
};
/** A prompt’s answer; a card it raised is answered no, so a test on code that raises one ends rather than waits. */
export async function settled(s, asked) {
  const n = cards(s).length;
  const r = await Promise.race([asked, until(() => cards(s).length > n).then(() => null)]);
  if (r) return r;
  await s.rt.act(s.t.id, cards(s).at(-1).id, 'deny', {});
  return asked;
}
const mappers = new WeakMap();
/** The turn’s stream parser, the real one, wired to the turn context `c` as the adapter wires it. */
function mapperOf(c) {
  if (!mappers.has(c)) {
    const m = createStreamMapper(c);
    c.subagentNames((ids) => m.who(ids));
    mappers.set(c, m);
  }
  return mappers.get(c);
}
/** The recorded stream’s lines `from` to `to` into the turn, through the real parser. */
export function feed(c, from, to = STREAM.length) {
  for (const e of STREAM.slice(from, to)) mapperOf(c).push(e);
}
/** One event into the turn, through the real parser. */
export const pushEvent = (c, e) => mapperOf(c).push(e);
