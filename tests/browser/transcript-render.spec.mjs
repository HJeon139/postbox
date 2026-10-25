// How the transcript renders what agents write, beside transcript.spec.mjs (how it follows them), with real mouse and
// keyboard input:
// - a reply shared back from a topic thread draws its math and diagrams and links the thread’s glossary, as an
//   agent’s reply does (#99), and keeps its question apart (#111);
// - a glossary term inside a definition opens a card of its own over its parent’s, by mouse and by keyboard; leaving
//   the child closes only the child, a cycle (U → U:13 → U) and a fourth level open nothing, and the cards stay on
//   screen at 375 px (#103);
// - a later turn of the same agent gets its own sender line, with its time and what woke it (another agent, or a
//   scheduled wake), while one turn’s items share one; so does each wake it sent from a turn of its own, in a side
//   thread (#135).
// Moved from tools/check-transcript-render.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let persona;
/** The conversation with the shared replies, and the one with the nested glossary. */
const T = {};

test.beforeAll(async () => {
  app = await startPostbox('transcript-render');
  const { rt } = app;
  const project = Object.values(rt.s.projects)[0];
  persona = rt.createPersona({ handle: 'analyst' });
  shared(project);
  nested(project);
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

/**
 * #103: a conversation whose glossary nests. The terms from #103’s report: U’s definition names U:13, and U:13’s names
 * U back. alpha → beta → gamma → delta is one level deeper than the cards go.
 */
function nested(project) {
  const { rt } = app;
  T.nested = rt.createThread({ projectId: project.id, title: 'Nested glossary', personaIds: [persona.id] });
  const ns = rt.sessionsIn(T.nested.id)[0];
  const define = rt.toolsFor(ns.id).define_term;
  define({ term: 'U', definition: 'The utility of a claim: U is the sum over its labels, such as U:13.' });
  define({ term: 'U:13', definition: 'The utility of label 13, one term of U.' });
  for (const [term, next] of [
    ['alpha', 'beta'],
    ['beta', 'gamma'],
    ['gamma', 'delta'],
  ])
    define({ term, definition: `Leads on to ${next}.` });
  define({ term: 'delta', definition: 'The last one.' });
  rt.addItem(T.nested.id, { kind: 'agent', sessionId: ns.id, personaId: ns.personaId, handle: ns.handle, text: 'Rank by U. Start at alpha.', status: 'done' });
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

// ── #103: nested glossary cards ─────────────────────────────────────────────────────────

const card = (page, term) => page.getByRole('dialog', { name: `Glossary: ${term}`, exact: true });
const reply = (page) => page.locator(`.transcript[data-thread="${T.nested.id}"] .turn .md`);
/** The cards open, bottom to top. */
const openCards = (page) => page.locator('.hovercard').evaluateAll((cs) => cs.map((c) => c.getAttribute('aria-label')?.replace('Glossary: ', '')));
/** Points at a term in a card (or the reply), and waits for its own card to pin. */
async function hover(page, from, term, key = term.toLowerCase()) {
  await (from ? card(page, from) : reply(page)).locator(`.term[data-term="${key}"]`).hover();
  await expect(card(page, term), `the card for ${term}, pinned`).toHaveClass(/\bpinned\b/);
}
/** U’s card, pinned from the keyboard: Enter on U in the reply. */
async function pinU(page) {
  await reply(page).locator('.term[data-term="u"]').focus();
  await page.keyboard.press('Enter');
  await expect(card(page, 'U')).toHaveClass(/\bpinned\b/);
}
/**
 * That pointing at a term opened no card. A card opens as the pointer arrives, and only pins after a still moment, so
 * two frames after the move is when it would be there.
 */
async function opensNothing(page, from, key, want) {
  await card(page, from).locator(`.term[data-term="${key}"]`).hover();
  await frames(page);
  expect(await openCards(page)).toEqual(want);
}
async function openNested(page) {
  await open(page, `#/t/${T.nested.id}`);
  await expect(reply(page).locator('.term').first()).toBeVisible();
}

test('#103 hovering U, then U:13 in its card, shows both; leaving U:13 for U’s card closes only U:13', async ({ page }) => {
  await openNested(page);
  await hover(page, null, 'U');
  await expect(card(page, 'U').locator('.term[data-term="u"]'), 'U’s definition doesn’t link U itself').toHaveCount(0);
  await hover(page, 'U', 'U:13', 'u-13');
  expect(await openCards(page)).toEqual(['U', 'U:13']);
  await card(page, 'U:13').locator('.hc-head').hover();
  await card(page, 'U').locator('.hc-head').hover();
  await expect(card(page, 'U:13'), 'U:13’s card closes').toHaveCount(0);
  expect(await openCards(page)).toEqual(['U']);
  // Nothing counts down to close U’s card: a card closing after its pointer left shows its bar running out.
  const running = await card(page, 'U')
    .locator('.loadbar i')
    .evaluate((i) => i.getAnimations().filter((a) => a.playState === 'running').length);
  expect(running, 'U’s card stays').toBe(0);
});

test('#103 a cycle opens no more cards: U inside U:13’s card, under U’s', async ({ page }) => {
  await openNested(page);
  await hover(page, null, 'U');
  await hover(page, 'U', 'U:13', 'u-13');
  await opensNothing(page, 'U:13', 'u', ['U', 'U:13']);
});

test('#103 cards go three deep: delta inside gamma’s card opens nothing', async ({ page }) => {
  await openNested(page);
  await hover(page, null, 'alpha');
  await hover(page, 'alpha', 'beta');
  await hover(page, 'beta', 'gamma');
  await opensNothing(page, 'gamma', 'delta', ['alpha', 'beta', 'gamma']);
});

test('#103 by keyboard: Enter pins and moves into the card, Tab reaches U:13, Escape closes one card at a time', async ({ page }) => {
  await openNested(page);
  const at = () =>
    page.evaluate(() => {
      const a = /** @type {HTMLElement} */ (document.activeElement);
      return `${a.closest('.hovercard')?.getAttribute('aria-label') ?? 'page'} ${a.dataset.term ?? a.className}`;
    });
  await pinU(page);
  expect(await at(), 'Enter pins U’s card and moves into it').toBe('Glossary: U hovercard pinned');
  await page.keyboard.press('Tab');
  await expect.poll(at, { message: 'Tab reaches U:13' }).toBe('Glossary: U u-13');
  await page.keyboard.press('Space');
  await expect(card(page, 'U:13')).toHaveClass(/\bpinned\b/);
  expect(await openCards(page), 'Space pins U:13’s card over U’s').toEqual(['U', 'U:13']);
  await page.keyboard.press('Escape');
  await expect.poll(() => openCards(page), { message: 'Escape closes the top card' }).toEqual(['U']);
  await expect.poll(at, { message: 'and focus returns to its term' }).toBe('Glossary: U u-13');
  await page.keyboard.press('Escape');
  await expect.poll(() => openCards(page)).toEqual([]);
  await expect.poll(at, { message: 'focus returns to U in the reply' }).toBe('page u');
});

test('#103 a card that closes while it has focus, as the pointer opens another, gives focus back to its term', async ({ page }) => {
  await openNested(page);
  await pinU(page);
  await hover(page, null, 'alpha');
  expect(await openCards(page), 'the pointer’s card replaces U’s').toEqual(['alpha']);
  await expect(reply(page).locator('.term[data-term="u"]'), 'focus is back on U in the reply').toBeFocused();
});

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('#103 at 375 px, both cards stay on screen, and nothing scrolls sideways', async ({ page }) => {
    await openNested(page);
    // Opened by keyboard, which pins at once: pointing needs 650 ms of a still pointer, and under load timed out (#271).
    await pinU(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(card(page, 'U:13')).toHaveClass(/\bpinned\b/);
    const inside = await page.locator('.hovercard').evaluateAll((cs) =>
      cs.map((c) => {
        const r = c.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }),
    );
    expect(inside, 'each card inside the window').toEqual([true, true]);
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), 'no sideways scroll').toBe(true);
  });
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

test('#135 a later turn of the same agent has its own sender line with its time and what woke it, and wakes from two turns each have one', async ({ page }) => {
  const { rt, store } = app;
  // The mixed-room UAT run (22 October 2026), step 6: @critic replied, then spoke again in a new turn after @researcher
  // answered it in their side thread, and the second message showed with no sender line. Here @analyst wakes
  // @reviewer, which answers in the side thread, and a second answer comes back as endTurn sends one (saidIn).
  const room = rt.createThread({
    projectId: Object.values(rt.s.projects)[0].id,
    title: 'Turn checks',
    personaIds: [persona.id, rt.createPersona({ handle: 'reviewer' }).id],
  });
  const an = rt.sessionsIn(room.id).find((x) => x.handle === 'analyst');
  const idle = () => expect.poll(() => rt.turns.size + rt.exiting.size, { message: 'the agents to finish', timeout: 20_000 }).toBe(0);
  rt.agentWake(an.id, 'reviewer', 'Check revision 3.');
  await idle();
  const side = Object.values(rt.s.threads).find((x) => x.kind === 'side' && x.parentId === room.id);
  rt.deliver(an.id, { kind: 'agent', from: '@reviewer', text: 'Revision 3 has one arithmetic gap.', saidIn: side.id });
  await idle();
  // One turn of two items, as a reply split by a block is: they keep one sender line.
  for (const text of ['Part one.', 'Part two.'])
    rt.addItem(room.id, { kind: 'agent', sessionId: an.id, personaId: an.personaId, handle: 'analyst', turnId: 'turn_135', text, status: 'done' });
  await open(page, `#/t/${room.id}`);
  await test.step('the next turn has its own sender line, its time and what woke it; one turn’s two items share one', async () => {
    await expect.poll(async () => (await senders(page, room.id)).length).toBeGreaterThanOrEqual(4);
    const [, second, one, two] = (await senders(page, room.id)).slice(-4);
    expect(second).toMatch(/^@analyst.*after @reviewer replied in a side thread.*\[time\]$/);
    expect([one, two]).toEqual([expect.stringMatching(/^@analyst.*\[time\]$/), '']);
  });
  await test.step('a turn a scheduled wake started says so on its sender line', async () => {
    // As the timer delivers it ({ kind: 'wake', note }, server/adapters/adapter.mjs).
    const replies = () => store.items(room.id).filter((x) => x.kind === 'agent' && x.handle === 'analyst').length;
    const had = replies();
    rt.schedule(an.id, { inMs: 1000, note: 'Look at the totals again.' });
    await expect.poll(replies, { message: 'the scheduled turn' }).toBeGreaterThan(had);
    await idle();
    await synced(page, app);
    await expect.poll(async () => (await senders(page, room.id)).at(-1)).toMatch(/^@analyst.*woken by a scheduled wake/);
  });
  await test.step('two wakes from two turns each have a sender line in the side thread, and one turn’s two share it', async () => {
    // As agentWake records them while @reviewer was busy: each says the turn it came from.
    for (const [n, text] of ['Check the totals.', 'And the dates, please.', 'And the names.'].entries())
      rt.addItem(side.id, {
        kind: 'agent',
        sessionId: an.id,
        personaId: an.personaId,
        handle: 'analyst',
        text,
        status: 'done',
        hop: n + 1,
        fromTurnId: `turn_135_${Math.min(n, 1)}`,
      });
    await open(page, `#/t/${room.id}/side/${side.id}`);
    await expect(page.locator(`.transcript[data-thread="${side.id}"] .md p`, { hasText: 'And the names.' })).toBeVisible();
    const wakes = (await senders(page, side.id)).slice(-3);
    expect(wakes).toEqual([expect.stringMatching(/^@analyst/), expect.stringMatching(/^@analyst/), '']);
  });
});
