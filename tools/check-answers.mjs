// A headless Chrome check of answering a block that changed while you were answering it (#123):
//   • a review: the agent replaces the draft while you comment. Your Submit is refused, the block says “This draft
//     changed while you were answering”, shows the diff from the text you saw, keeps your comment on its line, and
//     moves focus to the notice. A further revision before you submit again is refused again. Then Submit sends
//     the review, for the revision on screen.
//   • a choice: the same refusal, with a plain notice, and your pick kept.
//
//   node tools/check-answers.mjs
//
// It runs its own Postbox, with a fresh data folder and a scripted agent, and its own headless Chrome.
// PB_PORT and PB_CHROME_PORT move them, so sessions working in parallel don’t collide. SHOTS=dir saves a screenshot
// of the review after the refusal.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT: CHROME } = await ports(4950, 10150);

const V1 = ['# Draft issue', '', 'Steps to reproduce:', '1. Open a review.', '2. Answer it.'].join('\n');
// Revision 2 adds a line near the top, so the line you commented on (“Steps to reproduce:”) moves from 3 to 4.
const V2 = ['# Draft issue', '', 'Seen on 22 October.', 'Steps to reproduce:', '1. Open a review.', '2. Answer it.'].join('\n');
// Revision 3 adds a last line, so the comment stays on line 4.
const V3 = `${V2}\n3. Watch the answer vanish.`;
const review = (content, extra = {}) => ({
  id: 'issue',
  type: 'review',
  version: 1,
  title: 'issue.md',
  fallback: 'The draft issue',
  format: 'markdown',
  content,
  ...extra,
});
const choice = (prompt) => ({
  id: 'pick',
  type: 'choice',
  version: 1,
  title: 'Which first?',
  fallback: 'Corpus or claims?',
  prompt,
  options: [
    { id: 'corpus', label: 'The corpus' },
    { id: 'claims', label: 'The claims' },
  ],
});

/** The agent: shows a block on cue, and records every message Postbox sends it. */
const calls = [];
const scripts = {
  review: (ctx) => ctx.tools.show_block({ block: review(V1) }),
  choice: (ctx) => ctx.tools.show_block({ block: choice('Load which first?') }),
};
const agent = {
  name: 'mock',
  async deliver(_session, message, ctx) {
    calls.push(message);
    if (message.kind === 'user') await scripts[message.text]?.(ctx);
  },
};

const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-answers-'));
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

try {
  const rt = app.rt;
  const project = Object.values(rt.s.projects)[0];
  const persona = rt.createPersona({ handle: 'drafter' });
  const thread = rt.createThread({ projectId: project.id, title: 'Answer checks', personaIds: [persona.id] });
  const se = rt.sessionsIn(thread.id)[0];
  const tools = rt.toolsFor(se.id);
  const itemOf = (id) => rt.store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === id);
  await page.size(1280, 900);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  const BLOCK = (id) => `document.querySelector('[data-block-item="${itemOf(id)?.id}"]')`;
  // A button by its label, as the person finds it.
  const BUTTON = (id, label) => `[...${BLOCK(id)}.querySelectorAll('button')].find((x) => x.textContent === '${label}')`;

  // ── Review ──
  rt.sendMessage(thread.id, { text: 'review' });
  await until(() => itemOf('issue'));
  await page.waitFor(`${BLOCK('issue')}?.querySelector('.g-mark[data-line="3"]')`, { label: 'the review block' });
  // You comment on line 3, “Steps to reproduce:”.
  await page.evaluate(`${BLOCK('issue')}.querySelector('.g-mark[data-line="3"]').click()`);
  await page.waitFor(`${BLOCK('issue')}.querySelector('textarea')`, { label: 'the comment box' });
  await page.evaluate(`(() => {
    const b = ${BLOCK('issue')}; b.querySelector('textarea').value = 'Say which build.';
    [...b.querySelectorAll('button')].find((x) => x.textContent === 'Add draft comment').click();
  })()`);
  await page.waitFor(`${BLOCK('issue')}.querySelector('.status-tag.draft')`, { label: 'the draft comment' });
  // Meanwhile, the agent replaces the draft with revision 2.
  tools.update_block({ block: review(V2) });
  await page.waitFor(`${BLOCK('issue')}.querySelector('.g-mark[data-line="6"]')`, { label: 'revision 2 on screen' });
  // You submit, from the keyboard’s point of view: focus on Submit review, then press it.
  await page.evaluate(`(() => { const s = ${BUTTON('issue', 'Submit review')}; s.focus(); s.click(); })()`);
  const note = await until(() => page.evaluate(`${BLOCK('issue')}?.querySelector('.stale-note')?.textContent ?? ''`));
  check(/^This draft changed while you were answering\./.test(note ?? ''), `review: the block says the draft changed (“${note}”)`);
  check(!itemOf('issue').answered, 'review: the answer was refused, so the block is still open');
  check(!calls.some((m) => m.kind === 'event'), 'review: nothing reached the agent');
  const shown = await page.evaluate(`(() => {
    const b = ${BLOCK('issue')};
    const view = [...b.querySelectorAll('.block-head .seg button')].map((x) => [x.textContent, x.getAttribute('aria-checked')]);
    const added = [...b.querySelectorAll('.rv-line.add')].map((l) => l.textContent);
    const draft = b.querySelector('.status-tag.draft')?.closest('.rv-thread');
    const before = draft?.previousElementSibling;
    return { view, added, draft: draft?.textContent ?? '', on: before?.textContent ?? '',
      role: b.querySelector('.stale-note')?.getAttribute('role'),
      focus: document.activeElement?.classList.contains('stale-note') ? 'the notice' : (document.activeElement?.textContent ?? ''), inBlock: b.contains(document.activeElement) };
  })()`);
  check(shown.view[0]?.[0] === 'Changes since you looked' && shown.view[0]?.[1] === 'true', 'review: the diff from the text you saw is shown');
  check(
    shown.added.some((t) => t.includes('Seen on 22 October.')),
    `review: the added line is marked (${JSON.stringify(shown.added)})`,
  );
  check(/Say which build\./.test(shown.draft), 'review: your draft comment is kept');
  check(/Steps to reproduce:/.test(shown.on), `review: it follows its line, now line 4 (it sits under “${shown.on.trim()}”)`);
  check(shown.role === 'alert', 'review: the notice is announced');
  check(shown.focus === 'the notice' && shown.inBlock, `review: focus moves to the notice, beside Submit review (${shown.focus})`);
  if (process.env.SHOTS) {
    await page.evaluate(`${BLOCK('issue')}.scrollIntoView({ block: 'center' })`);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(process.env.SHOTS, 'review-changed.png'), Buffer.from(data, 'base64'));
  }
  // Before you submit again, the agent makes revision 3: that’s refused too, with the notice announced again.
  tools.update_block({ block: review(V3) });
  await page.waitFor(`${BLOCK('issue')}.querySelector('.g-mark[data-line="7"]')`, { label: 'revision 3 on screen' });
  await page.evaluate(`${BUTTON('issue', 'Submit review')}.click()`);
  await sleep(500);
  const again = await page.evaluate(`${BLOCK('issue')}.querySelector('.stale-note')?.getAttribute('role') ?? ''`);
  check(!itemOf('issue').answered && again === 'alert', 'review: a revision after the refusal is refused again, and announced');
  // You submit again: it goes through, for revision 3, with the comment on line 4.
  await page.evaluate(`${BUTTON('issue', 'Submit review')}.click()`);
  const event = await until(() => calls.find((m) => m.kind === 'event' && m.event.blockId === 'issue'));
  check(event?.event.revision === 3, `review: the answer is for revision 3 (${event?.event.revision})`);
  check(event?.event.values.comments?.[0]?.line === 4, `review: the comment is on line 4 (${JSON.stringify(event?.event.values.comments)})`);
  check(itemOf('issue').answered === true, 'review: the block is answered');

  // ── Choice ──
  rt.sendMessage(thread.id, { text: 'choice' });
  await until(() => itemOf('pick'));
  await page.waitFor(`${BLOCK('pick')}?.querySelector('.chip')`, { label: 'the choice block' });
  await page.evaluate(`${BLOCK('pick')}.querySelector('.chip[data-n="2"]').click()`);
  tools.update_block({ block: choice('Load which first? The claims are ready now.') });
  await page.waitFor(`${BLOCK('pick')}.textContent.includes('ready now')`, { label: 'revision 2 of the choice' });
  await page.evaluate(`(() => { const s = ${BUTTON('pick', 'Send choice')}; s.focus(); s.click(); })()`);
  const plain = await until(() => page.evaluate(`${BLOCK('pick')}?.querySelector('.stale-note')?.textContent ?? ''`));
  check(/^This changed while you were answering\./.test(plain ?? ''), `choice: a plain notice (“${plain}”)`);
  const kept = await page.evaluate(`(() => { const b = ${BLOCK('pick')}; return {
    on: b.querySelector('.chip[data-n="2"]').getAttribute('aria-checked'), focus: document.activeElement?.classList.contains('stale-note') ? 'the notice' : '' }; })()`);
  check(kept.on === 'true', 'choice: your pick is kept');
  check(kept.focus === 'the notice', `choice: focus moves to the notice (${kept.focus})`);
  check(!itemOf('pick').answered, 'choice: refused, still open');
  await page.evaluate(`${BUTTON('pick', 'Send choice')}.click()`);
  const picked = await until(() => calls.find((m) => m.kind === 'event' && m.event.blockId === 'pick'));
  check(picked?.event.revision === 2 && picked.event.values.selected?.[0] === 'claims', 'choice: sent again, for revision 2');
  // The two refusals log as 409s; anything else is an error.
  const errors = page.logs.filter((l) => !/status of 409 .*\/act$/.test(l.trim()));
  check(!errors.length, `no errors in the page${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await page.close?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}

finish();
