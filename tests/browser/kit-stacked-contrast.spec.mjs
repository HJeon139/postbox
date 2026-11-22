// #1014: the kit’s stacked chart labels each segment in black or white, whichever contrasts more with its fill. Its
// black was #0b0b0b, and on light --s1 neither reached 4.5:1, so the app check (#997) held the app back for the kit’s
// own label. Pure black reaches at least 4.58:1 on any fill. A stacked chart with every series color, --s1 to --s8,
// passes the app check in both themes, at 375 and 1280 px, with every segment wide enough labeled.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnServerErrors, startPostbox, synced } from './postbox.mjs';

// Eight series, one per palette color, wide enough in a 1280 px window that every segment carries a label. The second row
// gives each series a different share, so the labels differ.
const CHART = `<div id="c" style="padding:8px"></div><script>
postbox.charts.stacked(document.getElementById('c'), {
  label: 'Hours by activity',
  categories: ['Week 1', 'Week 2'],
  series: ['Sleep', 'Work', 'Run', 'Read', 'Cook', 'Walk', 'Play', 'Rest'].map((name, i) => ({ name, values: [10, 6 + i] })),
});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
failOnServerErrors(test);
test.beforeAll(async () => {
  app = await startPostbox('kit-stacked-contrast');
  // The agent hears a failed check and doesn’t answer, so the app keeps what its first check found.
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});

for (const colorScheme of /** @type {const} */ (['light', 'dark']))
  test(`#1014 a stacked chart with every series color passes the app check in the ${colorScheme} theme`, async ({ browser }) => {
    test.setTimeout(60_000);
    const { rt } = app;
    const t = rt.createThread({
      projectId: Object.values(rt.store.state.projects)[0].id,
      title: `Stacked ${colorScheme}`,
      personaIds: [arrange.persona(rt, 'researcher').id],
    });
    const id = `stacked-${colorScheme}`;
    rt.toolsFor(arrange.agentIn(rt, t.id).id).show_app({ id, title: 'Hours by activity', code: CHART });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme });
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    const check = () => rt.store.state.apps[id].check;
    await expect.poll(() => check().status, { message: 'the app checked', timeout: 45_000 }).not.toBe('pending');
    const said = (check().problems ?? []).map((p) => `${p.code}: ${p.message}`).join('\n');
    expect(check().status, said || 'no problems').toBe('passed');
    const labels = page.frameLocator('iframe.app-iframe').locator('svg text[font-weight="600"]');
    // Two weeks of eight series, every segment wide enough in a 1280 px window: no label is left off.
    await expect.poll(() => labels.count(), { message: 'every segment is labeled' }).toBe(16);
    // Each label is in one of the two inks.
    const inks = await labels.evaluateAll((ts) => [...new Set(ts.map((t) => t.getAttribute('fill')))]);
    for (const ink of inks) expect(['#000000', '#ffffff'], `a label’s ink, ${ink}`).toContain(ink);
    await page.close();
  });
