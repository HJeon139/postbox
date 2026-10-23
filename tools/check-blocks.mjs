// A headless Chrome check of closing blocks that ask (#106):
//   • the person dismisses an open choice from the keyboard, with the button after its own answer buttons: it reads “Dismissed by you”, its Dismiss button goes,
//     the agent hears “dismiss”, and its agent stops needing them;
//   • the agent withdraws a choice it asked: it reads “Withdrawn by @drafter” with the reason, and can’t be answered;
//   • the agent records an outcome on an approved review: it shows under the answer, and the review stays answered.
//
//   node tools/check-blocks.mjs
//
// It runs its own Postbox, with a fresh data folder and a scripted agent, and its own headless Chrome.
// PB_PORT and PB_CHROME_PORT move them, so sessions working in parallel don’t collide.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT: CHROME } = await ports(4700, 9900);

const choice = (id, title) => ({
  id,
  type: 'choice',
  version: 1,
  title,
  fallback: title,
  options: [
    { id: 'issue', label: 'A new issue' },
    { id: 'comment', label: 'A comment' },
  ],
});
const review = { id: 'draft', type: 'review', version: 1, title: 'issue.md', fallback: 'The draft issue', format: 'markdown', content: '# Draft' };

/** The agent: shows a block on cue, and records every message Postbox sends it. */
const calls = [];
const scripts = {
  ask: (ctx) => ctx.tools.show_block({ block: choice('where', 'Where should I report this?') }),
  stale: (ctx) => ctx.tools.show_block({ block: choice('stale', 'Which tracker?') }),
  review: (ctx) => ctx.tools.show_block({ block: review }),
};
const agent = {
  name: 'mock',
  async deliver(_session, message, ctx) {
    calls.push(message);
    if (message.kind === 'user') await scripts[message.text]?.(ctx);
  },
};

const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-blocks-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
app.rt.adapters.register(agent);
const page = await launch({ port: CHROME });
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};
async function press(key, code, keyCode, text) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text, unmodifiedText: text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

try {
  const { rt, store } = app;
  const project = Object.values(rt.s.projects)[0];
  const persona = rt.createPersona({ handle: 'drafter' });
  const thread = rt.createThread({ projectId: project.id, title: 'Block checks', personaIds: [persona.id] });
  const se = rt.sessionsIn(thread.id)[0];
  const tools = rt.toolsFor(se.id);
  const itemOf = (id) => rt.store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === id);
  const BLOCK = (id) => `document.querySelector('[data-block-item="${itemOf(id)?.id}"]')`;
  const shown = (id) =>
    page.evaluate(`(() => { const b = ${BLOCK(id)}; return b && {
      note: b.querySelector('.closed-note')?.textContent ?? '', dismiss: !!b.querySelector('button.dismiss'),
      answered: b.classList.contains('answered'), enabled: [...b.querySelectorAll('.chip, button')].filter((x) => !x.disabled && !x.closest('.block-head')).length,
      outcome: b.querySelector('.outcome')?.textContent ?? '', voice: b.querySelector('.block-foot .answered-note')?.textContent ?? '' }; })()`);
  await page.size(1280, 900);
  await page.goto(`${app.origin}/#/t/${thread.id}`);

  // ── The person dismisses a choice ──
  rt.sendMessage(thread.id, { text: 'ask' });
  await until(() => itemOf('where') && !rt.turns.size);
  check(store.state.sessions[se.id].needs?.itemId === itemOf('where').id, 'the open choice makes its agent need you');
  await page.synced(store.state.seq);
  await page.waitFor(`${BLOCK('where')}?.querySelector('button.dismiss')`, { label: 'the Dismiss button' });
  // After the block’s own answer, so going to the block (⌃J, needs-you) and Tab reach the answer first.
  const order = await page.evaluate(`[...${BLOCK('where')}.querySelectorAll('button:not([disabled])')].map((b) => b.textContent).slice(-2)`);
  check(order.join(' · ') === 'Send choice · Dismiss', `an open choice has a Dismiss button, after Send choice (${order.join(' · ')})`);
  // From the keyboard: focus it and press Enter.
  await page.evaluate(`${BLOCK('where')}.querySelector('button.dismiss').focus()`);
  await press('Enter', 'Enter', 13, '\r');
  const heard = await until(() => calls.find((m) => m.kind === 'event' && m.event.blockId === 'where'));
  check(heard?.event.action === 'dismiss', `the agent hears “dismiss” (${heard?.event.action})`);
  check(store.state.sessions[se.id].needs === null, 'its agent no longer needs you');
  await page.synced(store.state.seq);
  await page.waitFor(`${BLOCK('where')}.querySelector('.closed-note')`, { label: 'the dismissed note' });
  const dismissed = await shown('where');
  check(/^Dismissed by you at \d\d:\d\d$/.test(dismissed.note), `it reads as dismissed by you (“${dismissed.note}”)`);
  check(!dismissed.dismiss && dismissed.answered && !dismissed.enabled, 'it’s closed: no Dismiss, and nothing to answer');

  // ── The agent withdraws a choice ──
  rt.sendMessage(thread.id, { text: 'stale' });
  await until(() => itemOf('stale') && !rt.turns.size);
  await page.synced(store.state.seq);
  await page.waitFor(`${BLOCK('stale')}?.querySelector('button.dismiss')`, { label: 'the second choice' });
  const r = tools.update_block({ block: { id: 'stale', withdraw: 'You answered in chat.' } });
  check(r.ok, `the agent withdraws it (${r.message})`);
  check(store.state.sessions[se.id].needs === null, 'its agent no longer needs you once it’s withdrawn');
  await page.synced(store.state.seq);
  await page.waitFor(`${BLOCK('stale')}.querySelector('.closed-note')`, { label: 'the withdrawn note' });
  const withdrawn = await shown('stale');
  check(/^Withdrawn by @drafter at \d\d:\d\d: You answered in chat\.$/.test(withdrawn.note), `it reads as withdrawn, by whom and why (“${withdrawn.note}”)`);
  check(!withdrawn.dismiss && withdrawn.answered && !withdrawn.enabled, 'it’s closed: no Dismiss, and nothing to answer');

  // ── An outcome on an approved review ──
  rt.sendMessage(thread.id, { text: 'review' });
  await until(() => itemOf('draft') && !rt.turns.size);
  rt.act(thread.id, itemOf('draft').id, 'submit', { verdict: 'approve', comments: [] }, 1);
  await until(() => itemOf('draft').answer?.read);
  const o = tools.update_block({ block: { ...review, outcome: 'Filed as #105.' } });
  check(o.ok, `the agent records an outcome on the approved review (${o.message})`);
  await page.synced(store.state.seq);
  await page.waitFor(`${BLOCK('draft')}?.querySelector('.outcome')`, { label: 'the review’s outcome' });
  const filed = await shown('draft');
  check(
    filed.outcome === 'Filed as #105.' && /^Submitted review: approve/i.test(filed.voice) && !filed.dismiss,
    `the outcome shows under the answer, and it stays answered (“${filed.outcome}”)`,
  );

  check(!page.logs.length, `no errors in the page${page.logs.length ? `: ${page.logs.join('; ')}` : ''}`);
} finally {
  await page.close?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}

finish();
