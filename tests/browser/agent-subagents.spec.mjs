// An agent at work with three subagents, as the Agents section and the narrow window’s ring strip show it:
// - #475: a ring’s “+N” sits clear of its drawn rings, and of the agent’s name beside it.
// - #476: a subagent’s row says what it was asked and its step, never its narration or its thoughts.
// The subagents are set on the session directly, in the shape the runtime stores (server/runtime.mjs, status()), as a
// turn with three Task calls would leave them; tests/browser/agents.spec.mjs replays a recorded stream for the same.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let planning;
let indexer;
test.beforeAll(async () => {
  app = await startPostbox('agent-subagents');
  planning = Object.values(app.store.state.threads).find((t) => t.title === 'Corpus planning');
  indexer = app.rt.sessionsIn(planning.id).find((x) => x.handle === 'indexer');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** Three subagents at work for @indexer, each narrating, the last one thinking. */
const THREE = ['a', 'b', 'c'].map((n, i) => ({
  id: `toolu_sub_${n}`,
  name: `reader-${n}`,
  state: 'tool',
  ctx: 20 + i,
  asked: `Read part ${n}`,
  doing: i === 2 ? 'Which of the three papers covers tokenizing?' : 'Read papers/part-a.md',
  ...(i === 2 ? { thinking: true } : {}),
  said: `I’ll read part ${n} next, then report the counts.`,
}));

async function atWork(page) {
  app.rt.updateSession(indexer.id, { state: 'tool', subagents: THREE });
  await page.goto(`${app.origin}/#/t/${planning.id}`);
  await synced(page, app);
}
test.afterEach(() => app.rt.updateSession(indexer.id, { state: 'idle', subagents: [] }));

/**
 * Every ring on screen that shows a “+N”: the box of the label’s text, of the rings it draws, and of what comes after
 * the ring’s slot (the agent’s name in the Agents section).
 */
const moreBoxes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('pb-ring')]
      .filter((x) => x.querySelector('.ring-more') && x.getBoundingClientRect().width > 0)
      .map((x) => {
        const box = (/** @type {DOMRect} */ r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        const text = document.createRange();
        text.selectNodeContents(/** @type {Element} */ (x.querySelector('.ring-more')));
        const circles = [...x.querySelectorAll('svg circle')].map((c) => c.getBoundingClientRect());
        const drawn = circles.reduce(
          (a, r) => ({ left: Math.min(a.left, r.left), right: Math.max(a.right, r.right), top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom) }),
          {
            left: Infinity,
            right: -Infinity,
            top: Infinity,
            bottom: -Infinity,
          },
        );
        const next = x.closest('.ring-slot')?.nextElementSibling;
        return {
          more: box(text.getBoundingClientRect()),
          drawn,
          next: next ? box(next.getBoundingClientRect()) : null,
          where: x.closest('.rail') ? 'rail' : 'strip',
        };
      }),
  );
const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

test('#476: a subagent’s row in the Agents section shows its task and a plain step, not its narration or thoughts', async ({ page }) => {
  await atWork(page);
  const subs = page.locator('.rail .agent-row .agent-sub.subagent');
  await expect(subs.locator('.sub-head')).toHaveText([
    'reader-a · subagent: Read part a',
    'reader-b · subagent: Read part b',
    'reader-c · subagent: Read part c',
  ]);
  await expect(subs.locator('.sub-now')).toHaveText(['Read papers/part-a.md', 'Read papers/part-a.md', 'Thinking']);
  const section = page.locator('.rail .agents-sec');
  await expect(section).not.toContainText('I’ll read part');
  await expect(section).not.toContainText('Thinking:');
  await expect(section).not.toContainText('Which of the three papers');
});

for (const theme of /** @type {const} */ (['light', 'dark']))
  for (const width of [1280, 375])
    test.describe(`at ${width} px (${theme})`, () => {
      test.use({ viewport: { width, height: 800 }, colorScheme: theme });

      test(`#475: a ring’s “+N” is clear of its rings and of the name beside it, at ${width} px (${theme})`, async ({ page }) => {
        await atWork(page);
        const rings = await moreBoxes(page);
        // The Agents section at 1280 px; the ring strip at 375 px, where the sidebar doesn’t show.
        expect(rings.map((r) => r.where)).toContain(width === 1280 ? 'rail' : 'strip');
        for (const r of rings) {
          expect(r.more.right - r.more.left, 'the label has a width').toBeGreaterThan(0);
          expect(apart(r.more, r.drawn), `“+1” clear of the drawn rings in the ${r.where}: ${JSON.stringify(r)}`).toBe(true);
          if (r.next) expect(apart(r.more, r.next), `“+1” clear of the name in the ${r.where}: ${JSON.stringify(r)}`).toBe(true);
          if (r.next) expect(r.drawn.right, 'the rings end before the name').toBeLessThanOrEqual(r.next.left);
        }
      });
    });
