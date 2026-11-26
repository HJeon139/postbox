// #1686: text a person or an agent reads is cut by length only at a whole character (cutText, #675), never between
// the two halves of a surrogate pair, which the reader would see as two replacement characters. Each case puts an
// emoji across the site’s cut.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { questionBlocks } from '../server/ask-question.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { draftOf } from '../server/write-guard.mjs';
import * as arrange from './arrange.mjs';
import { settle } from './blocks-fixture.mjs';

const EMOJI = '😀';
/** Text whose emoji starts at the last character a cut at n keeps, so a raw slice keeps half of it. */
const across = (n, pad = 'x') => pad.repeat(n - 1) + EMOJI + 'tail';
/** Whether text holds a lone half of a surrogate pair. */
const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(s));
function whole(s, where) {
  assert.equal(typeof s, 'string', `${where} wasn’t found`);
  assert.equal(lone(s), false, `${where} ends inside a character`);
}

/** Every string in a value, however deep. @param {unknown} v @returns {string[]} */
function stringsIn(v) {
  if (typeof v === 'string') return [v];
  return v && typeof v === 'object' ? Object.values(v).flatMap(stringsIn) : [];
}

/** A conversation with one agent; step(ctx) runs inside each of its turns. */
function room() {
  const store = new Store(null);
  /** @type {(ctx: any) => Promise<void>} */
  let step = async () => {};
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {},
      fork() {},
      async deliver(_s, _m, ctx) {
        await step(ctx);
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: ['alpha', 'beta'].map((handle) => rt.createPersona({ handle }).id) });
  const se = arrange.agentIn(rt, t.id, 'alpha');
  /** Runs fn(ctx) in a turn of the agent’s, and gives what it returns once the turn ends. */
  const during = async (fn) => {
    let out;
    step = async (ctx) => {
      out = await fn(ctx);
    };
    rt.sendMessage(t.id, { text: '@alpha go' });
    await settle(rt);
    return out;
  };
  const items = (kind) => store.items(t.id).filter((i) => i.kind === kind);
  return { rt, store, t, se, during, items };
}

test('#1686 an id or block id nobody has is quoted whole in the refusal: react and review_block', async () => {
  const r = room();
  whole(r.rt.toolsFor(r.se.id).react({ id: across(80), emoji: '👍' }).message, 'react');
  whole(r.rt.toolsFor(r.se.id).review_block({ blockId: across(80), comments: [{ line: 1, text: 'x' }] }).message, 'review_block');
});

test('#1686 a review comment whose quote doesn’t match shows the text there cut whole', async () => {
  const r = room();
  const content = `${across(120)} and more`;
  const shown = r.rt.toolsFor(r.se.id).show_block({ block: { id: 'doc', type: 'review', version: 1, fallback: 'f', format: 'markdown', content } });
  assert.equal(shown.ok, true, shown.message);
  const other = arrange.agentIn(r.rt, r.t.id, 'beta');
  const res = r.rt.toolsFor(other.id).review_block({ blockId: 'doc', comments: [{ line: 1, col: 1, endLine: 1, endCol: 130, quote: 'not it', text: 'x' }] });
  assert.match(res.message, /its quote isn’t the text at those columns/);
  whole(res.message, 'the quote refusal');
});

test('#1686 a scheduled wake’s note and a defined term are kept whole', async () => {
  const r = room();
  await r.during(async () => {
    r.rt.toolsFor(r.se.id, r.rt.turns.get(r.se.id)).schedule_wake({ in_minutes: 5, note: across(200) });
    r.rt.toolsFor(r.se.id, r.rt.turns.get(r.se.id)).define_term({ term: across(80), definition: across(2000), source: across(200) });
  });
  // Every string the two calls stored that starts with the padding: the note, and the term twice (#1686).
  const kept = stringsIn(r.store.state).filter((x) => x.startsWith('xxxx'));
  assert.ok(kept.length >= 2, `found ${kept.length}`);
  for (const x of kept) whole(x, 'a stored note or term');
});

test('#1686 the person’s message, and an edit of one waiting in a queue, are cut whole at 50,000 characters', async () => {
  const r = room();
  r.rt.sendMessage(r.t.id, { text: across(50000) });
  whole(r.items('user').at(-1)?.text, 'the message');
  // A message waits while the agent’s turn runs; its edit is cut the same way.
  let release = () => {};
  const busy = r.during(() => new Promise((ok) => (release = ok)));
  for (let i = 0; i < 100 && !r.rt.turns.get(r.se.id); i++) await new Promise((ok) => setTimeout(ok, 5));
  r.rt.sendMessage(r.t.id, { text: '@alpha next' });
  const entry = r.rt.delivery.waiting(r.se.id).find((e) => e.itemId);
  r.rt.editQueued(r.t.id, entry.id, across(50000));
  whole(r.store.items(r.t.id).find((i) => i.id === entry.itemId)?.text, 'the edited message');
  release();
  await busy;
});

test('#1686 a compaction’s summary, a permission card’s summary, and a refusal’s summary, detail and reason are cut whole', async () => {
  const r = room();
  await r.during(async (ctx) => {
    ctx.compaction({ kept: 1, total: 2, summary: across(20000) });
    const turn = r.rt.turns.get(r.se.id);
    void r.rt.requestPermission(r.se.id, { tool: 'Bash', summary: across(200), input: { command: 'ls' } });
    r.rt.recordDenial(turn, { tool: 'Bash', input: { command: across(4000) }, label: across(200), reason: across(400), toolUseId: 'tu_1' });
  });
  whole(r.items('system').find((i) => i.variant === 'compaction')?.summary, 'the compaction summary');
  whole(r.items('permission')[0]?.summary, 'the permission card’s summary');
  const denial = r.items('denial')[0];
  for (const k of ['summary', 'detail', 'reason']) whole(denial?.[k], `the refusal’s ${k}`);
});

test('#1686 a write’s draft text and a question’s fallback are cut whole', () => {
  const tool = 'mcp__claude_ai_Notion__notion-create-pages';
  const d = draftOf(tool, { content: across(20000) });
  whole(d?.text, 'the draft');
  // The fallback is the question and a line per label; the last label puts its emoji across character 4,000.
  const question = 'q'.repeat(1300);
  const labels = Array.from({ length: 24 }, (_, i) => `${i}`.padEnd(110, 'l'));
  const before = `${question}\n${labels.map((l) => `- ${l}`).join('\n')}`.length;
  const at = 4000 - 1 - (before - labels.at(-1).length);
  labels[labels.length - 1] = `${'l'.repeat(at)}${EMOJI}`.padEnd(110, 'l');
  const blocks = questionBlocks({ questions: [{ question, options: labels.map((label) => ({ label })) }] });
  assert.ok(blocks, 'the question can be shown as a choice');
  whole(blocks[0].fallback, 'the question’s fallback');
});
