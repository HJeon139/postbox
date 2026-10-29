import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('glimpse');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const LATEST = 'The implementation now passes its focused checks. I am reading the final report before review.';
const CHANGED = 'The focused checks still pass. I am comparing the final diff with the issue now.';

function room(title) {
  const { rt, store } = app;
  const persona = rt.createPersona({ handle: `worker-${title}` });
  const thread = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title, personaIds: [persona.id] });
  const session = rt.sessionsIn(thread.id)[0];
  for (let i = 1; i <= 30; i++)
    rt.addItem(thread.id, {
      kind: 'agent',
      sessionId: session.id,
      personaId: session.personaId,
      handle: session.handle,
      text: `Finding ${i}. The evidence stays in the transcript so the working row begins below it.`,
      status: 'done',
    });
  return { rt, thread, session };
}

for (const width of [1280, 375])
  test(`#478 at ${width} px a sentence-boundary glimpse uses at most three lines and the view stays at the end`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    const { rt, thread, session } = room(String(width));
    await page.goto(`${app.origin}/#/t/${thread.id}`);
    await synced(page, app);
    await settled(page);

    rt.updateSession(session.id, { state: 'think', currentStep: 'Thinking', glimpse: LATEST });
    await synced(page, app);
    const glimpse = page.locator('.working .glimpse');
    await expect(glimpse).toHaveText(LATEST);
    await settled(page);
    const first = await glimpse.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        height: node.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        text: node.textContent ?? '',
        whiteSpace: style.whiteSpace,
        lines: style.webkitLineClamp,
      };
    });
    expect(first.text.startsWith('…') || first.text.endsWith('…'), 'no ellipsis at either end').toBe(false);
    expect(first.whiteSpace, 'the glimpse wraps').toBe('normal');
    expect(first.lines, 'a fourth line shows its cut').toBe('3');
    expect(first.height / first.lineHeight, 'at most three lines').toBeLessThanOrEqual(3.05);
    await expect.poll(() => page.evaluate(() => Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight))).toBeLessThanOrEqual(2);

    rt.updateSession(session.id, { glimpse: LATEST });
    await synced(page, app);
    await expect(glimpse).toHaveText(first.text);
    await settled(page);
    await expect(glimpse, 'the row keeps its height when the bounded glimpse is unchanged').toHaveCSS('height', `${first.height}px`);

    rt.updateSession(session.id, { glimpse: CHANGED });
    await synced(page, app);
    await expect(glimpse).toHaveText(CHANGED);
    await settled(page);
    await expect.poll(() => page.evaluate(() => Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight))).toBeLessThanOrEqual(2);
  });
