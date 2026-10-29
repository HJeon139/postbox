// How the transcript renders what agents write, beside transcript.spec.mjs (how it follows them), with real mouse and
// keyboard input:
// - a reply shared back from a topic thread draws its math and diagrams and links the thread’s glossary, as an
//   agent’s reply does (#99), and keeps its question apart (#111);
// - a later turn of the same agent gets its own sender line, with its time and what woke it (another agent, or a
//   scheduled wake), while one turn’s items share one; so does each wake it sent from a turn of its own, in a side
//   thread (#135).
// glossary-cards.spec.mjs checks nested glossary cards (#103). Moved from tools/check-transcript-render.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let persona;
/** The conversation with the shared replies. */
const T = {};

test.beforeAll(async () => {
  app = await startPostbox('transcript-render');
  const { rt } = app;
  const project = Object.values(rt.s.projects)[0];
  persona = rt.createPersona({ handle: 'analyst' });
  shared(project);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** #99, #111: a conversation with a summary and a reply shared back from its topic thread. */
function shared(project) {
  const { rt } = app;
  const thread = rt.createThread({ projectId: project.id, title: 'Render checks', personaIds: [persona.id] });
  const se = rt.sessionsIn(thread.id)[0];
  rt.toolsFor(se.id).define_term({ term: 'macro-F1', definition: 'The mean of the F1 score of each label, so a rare label counts as much as a common one.' });
  const said = rt.addItem(thread.id, {
    kind: 'agent',
    sessionId: se.id,
    personaId: se.personaId,
    handle: se.handle,
    text: 'The scores are in.',
    status: 'done',
  });
  const { threadId: topic } = rt.startTopic(thread.id, said.id);
  // A term defined in the topic thread, where the summary was written, and not in the conversation. The topic has no
  // session of its own (#228): the agent’s one session answers there, in a turn that speaks in the topic.
  rt.toolsFor(se.id, { threadId: topic }).define_term({ term: 'label weight', definition: 'How many of the 300 claims carry a label.' });
  // The formula is the one wave 2’s SciFact UAT saw as source in the conversation’s copy (#99).
  const text = [
    'The macro-F1 over both labels, each by its label weight:',
    '',
    '$$',
    '(188 \\times 0.812 + 112 \\times 0.409)/300 = 0.661',
    '$$',
    '',
    '```mermaid',
    'flowchart LR',
    '  claims[Claims] --> abstracts[Abstracts]',
    '```',
  ];
  T.summary = rt.shareText(thread.id, { fromThreadId: topic, handle: 'analyst', summary: true, text: text.join('\n') });
  // A reply that keeps its question (#111): one whose fence would have swallowed the answer, were they one text.
  T.answered = rt.shareText(thread.id, {
    fromThreadId: topic,
    handle: 'analyst',
    text: 'Use chapter offsets.',
    question: 'Which?\n```js\nconst unit = "page"',
  });
  T.shared = thread;
}

async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
}

// ── #99, #111: a reply shared back from a topic thread ──────────────────────────────────

test('#111 a shared reply shows its question apart, and the answer isn’t swallowed by it', async ({ page }) => {
  await open(page, `#/t/${T.shared.id}`);
  const card = page.locator(`[data-key="${T.answered.id}"] .shared-card`);
  await expect(card.locator('.shared-q pre')).toBeVisible();
  const answer = await card.locator('p').evaluateAll((ps) => ps.some((p) => p.textContent === 'Use chapter offsets.' && !p.closest('pre, .shared-q')));
  expect(answer, 'the answer stands on its own').toBe(true);
});

test('#99 a shared summary draws its math and its Mermaid diagram, and links the conversation’s and its topic’s glossaries', async ({ page }) => {
  await open(page, `#/t/${T.shared.id}`);
  const card = page.locator(`[data-key="${T.summary.id}"] .shared-card`);
  // KaTeX keeps the source in its MathML, so what’s read is whether every formula was drawn.
  await expect
    .poll(() => card.locator('.md-math').evaluateAll((m) => m.length > 0 && m.every((x) => x.querySelector('.katex-html'))), {
      message: 'its math drawn, not its source',
      timeout: 15_000,
    })
    .toBe(true);
  await expect(card.locator('figure.diagram iframe'), 'its diagram drawn in a frame').toHaveAttribute('data-sized', /./, { timeout: 15_000 });
  await expect(card.locator('.term').first(), 'the conversation’s glossary').toHaveAttribute('data-term', 'macro-f1');
  // And the glossary of the topic it was written in, with its card.
  const topicTerm = card.locator('.term[data-term="label-weight"]');
  await expect(topicTerm).not.toHaveClass(/\bundef\b/);
  await topicTerm.hover();
  await expect(page.locator('.hovercard')).toHaveAttribute('aria-label', 'Glossary: label weight');
});

test('#466 the schedule line shows a pending retry and when automatic retries stop', async ({ page }) => {
  const { rt, store } = app;
  const room = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: 'Retry line', personaIds: [persona.id] });
  const se = rt.sessionsIn(room.id)[0];
  const sc = rt.schedule(se.id, { inMs: 60_000, note: 'Check the run.' });
  rt.patchItem(room.id, sc.itemId, { status: 'pending', retryAttempt: 3, at: Date.now() + 30_000 });
  await open(page, `#/t/${room.id}`);
  const line = page.locator(`[data-key="${sc.itemId}"]`);
  await expect(line).toContainText(/will retry its scheduled wake.*network error · attempt 3/);
  await expect(line.getByRole('button', { name: 'Cancel' })).toBeVisible();

  rt.patchItem(room.id, sc.itemId, { status: 'done', retryAttempt: 3 });
  await synced(page, app);
  await expect(line).toContainText(/woke itself/);
  await expect(line).not.toContainText(/will retry/);
  rt.patchItem(room.id, sc.itemId, { status: 'canceled', retryAttempt: 3 });
  await synced(page, app);
  await expect(line).toContainText(/won’t wake itself \(canceled\)/);
  await expect(line).not.toContainText(/will retry/);

  clearTimeout(rt.timers.get(sc.id));
  rt.timers.delete(sc.id);
  store.emit('schedule', { id: sc.id, removed: true });
  rt.patchItem(room.id, sc.itemId, { status: 'pending', retryStopped: true });
  await synced(page, app);
  await expect(line).toContainText(/stopped retrying.*after an hour of network errors/);
  await expect(line.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
});

// ── #135: a later turn of the same agent gets its own sender line ───────────────────────

/** The sender line of each item with words in a transcript, with “[time]” where it shows one, or "" where it has none. */
const senders = (page, threadId) =>
  page.locator(`.transcript[data-thread="${threadId}"] > .item`).evaluateAll((ns) =>
    ns
      .filter((n) => n.querySelector('.md p'))
      .map((n) => {
        const w = /** @type {HTMLElement | null} */ (n.querySelector('.who'));
        // biome-ignore lint/performance/useDomNodeTextContent: the sender line as a reader sees it, without its hidden labels
        return w ? w.innerText.replace(/\s+/g, ' ').trim() + (w.querySelector('.ts') ? ' [time]' : '') : '';
      }),
  );

/** A turn a scheduled wake started says so on its sender line. */
async function scheduledWake(page, room, an, idle) {
  const { rt, store } = app;
  // As the timer delivers it ({ kind: 'wake', note }, server/adapters/adapter.mjs).
  const replies = () => store.items(room.id).filter((x) => x.kind === 'agent' && x.handle === 'analyst').length;
  const had = replies();
  rt.schedule(an.id, { inMs: 1000, note: 'Look at the totals again.' });
  await expect.poll(replies, { message: 'the scheduled turn' }).toBeGreaterThan(had);
  await idle();
  await synced(page, app);
  const last = async () => (await senders(page, room.id)).at(-1);
  await expect.poll(last, { message: 'the scheduled turn’s sender line' }).toMatch(/^@analyst.*woken by a scheduled wake/);
  await frames(page);
  expect(await last(), 'and it held').toMatch(/^@analyst.*woken by a scheduled wake/);
}

test('#135 a later turn of the same agent has its own sender line with its time and what woke it, and wakes from two turns each have one', async ({ page }) => {
  const { rt } = app;
  // The mixed-room UAT run (22 October 2026), step 6: @critic replied, then spoke again in a new turn after @researcher
  // answered it, and the second message showed with no sender line. Here @analyst wakes @reviewer, which answers in the
  // conversation (#372), and @reviewer’s @-mention wakes @analyst again.
  const room = rt.createThread({
    projectId: Object.values(rt.s.projects)[0].id,
    title: 'Turn checks',
    personaIds: [persona.id, rt.createPersona({ handle: 'reviewer' }).id],
  });
  const an = rt.sessionsIn(room.id).find((x) => x.handle === 'analyst');
  const idle = () => expect.poll(() => rt.turns.size + rt.exiting.size, { message: 'the agents to finish', timeout: 20_000 }).toBe(0);
  rt.agentWake(an.id, 'reviewer', 'Check revision 3.');
  await idle();
  rt.deliver(an.id, { kind: 'agent', from: '@reviewer', text: '@analyst revision 3 has one arithmetic gap.' });
  await idle();
  // One turn of two items, as a reply split by a block is: they keep one sender line.
  for (const text of ['Part one.', 'Part two.'])
    rt.addItem(room.id, { kind: 'agent', sessionId: an.id, personaId: an.personaId, handle: 'analyst', turnId: 'turn_135', text, status: 'done' });
  await open(page, `#/t/${room.id}`);
  await test.step('the next turn has its own sender line, its time and what woke it; one turn’s two items share one', async () => {
    await expect.poll(async () => (await senders(page, room.id)).length).toBeGreaterThanOrEqual(4);
    const [, second, one, two] = (await senders(page, room.id)).slice(-4);
    expect(second).toMatch(/^@analyst.*woken by @reviewer.*\[time\]$/);
    expect([one, two]).toEqual([expect.stringMatching(/^@analyst.*\[time\]$/), '']);
  });
  await test.step('a turn a scheduled wake started says so on its sender line', () => scheduledWake(page, room, an, idle));
  await test.step('two wakes from two turns each have a sender line in the conversation, and one turn’s two share it', async () => {
    // As agentWake records them while @reviewer was busy, in the conversation since #372: each says the turn it came from.
    for (const [n, text] of ['Check the totals.', 'And the dates, please.', 'And the names.'].entries())
      rt.addItem(room.id, {
        kind: 'agent',
        sessionId: an.id,
        personaId: an.personaId,
        handle: 'analyst',
        text,
        status: 'done',
        hop: n + 1,
        fromTurnId: `turn_135_${Math.min(n, 1)}`,
      });
    await expect(page.locator(`.transcript[data-thread="${room.id}"] .md p`, { hasText: 'And the names.' })).toBeVisible();
    const wakes = (await senders(page, room.id)).slice(-3);
    expect(wakes).toEqual([expect.stringMatching(/^@analyst/), expect.stringMatching(/^@analyst/), '']);
  });
});
