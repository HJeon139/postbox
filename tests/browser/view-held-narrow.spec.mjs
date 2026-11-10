// While you follow, what comes after the newest message shrinking (the working row going) would pull everything down
// under your pointer, so the transcript keeps that room below its newest message: its own bottom margin since #1150
// (view-state.mjs follow()), bottom padding read from `--held` before. Then the narrow window’s own padding rule set
// the bottom to 8 px and dropped the held room, so at 767 px or narrower the newest message moved down as what was
// below it went (#712a).
// Here it moved 47 px at 375 and 700 px before the fix. The wide window is transcript.spec.mjs’s #88 case.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-held-narrow');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const LINE = (n) => `Message ${n}. A line long enough to wrap twice in a narrow window, so the room is taller than the window.`;

for (const width of [375, 700])
  test(`at ${width} px, following, the newest message holds still as the working row below it goes`, async ({ page }) => {
    const { rt } = app;
    const project = Object.values(app.store.state.projects)[0];
    const t = rt.createThread({ projectId: project.id, title: `Held at ${width}`, personaIds: [rt.personaByHandle('critic').id] });
    const [critic] = rt.sessionsIn(t.id);
    for (let i = 1; i <= 30; i++) rt.addItem(t.id, { kind: 'user', text: LINE(i) });
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    await settled(page);
    await expect(page.locator('#main.transcript')).toHaveAttribute('data-view-mode', 'following');
    rt.updateSession(critic.id, { state: 'tool', currentStep: 'Searched the web', glimpse: 'Reading the first result.' });
    await expect(page.locator('.working .work-row')).toBeVisible();
    await settled(page);
    const newest = page.locator('#main.transcript > .item').last();
    const top = () => newest.evaluate((n) => Math.round(n.getBoundingClientRect().top));
    const before = await top();
    // The working row goes: the page would get shorter and pull the newest message down.
    rt.updateSession(critic.id, { state: 'idle', currentStep: '', glimpse: '' });
    await expect(page.locator('.working .work-row')).toHaveCount(0);
    await settled(page);
    expect(await top(), 'the newest message stayed where it was').toBe(before);
  });
