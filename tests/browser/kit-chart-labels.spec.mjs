// The kit’s bar (stacked) chart and heatmap made room for their category labels with a fixed left margin, so a long
// label, such as a note’s file name, ran off the page’s left edge (“s-from-the-coast.md”). The app check flagged it,
// and the agent couldn’t fix it, since the chart is the kit’s. The margin now grows with the longest label, measured as
// the chart draws it (tabular figures: dates measured on a canvas came out too narrow and were cut), up to half the
// chart’s width, and a label longer than that ends in “…” on a whole character, with its full name in a title and in
// the table view. Both charts pass the app check, at 375 and 1280 px, with every label inside its chart.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnServerErrors, startPostbox, synced } from './postbox.mjs';

const NOTES = ['notes/harbor-town.md', 'notes/letters-from-the-coast.md', 'notes/sayings.md'];
// Digits, which the charts draw as tabular figures, wider than a canvas measures them.
const DATES = ['2024-11-01', '2024-11-11', '2024-12-31', 'v1.10.11'];
// A label far longer than any chart could give room to, whose cut lands among characters of several code points each.
const FAMILY = '👨‍👩‍👧‍👦';
const LONG = `x${FAMILY.repeat(60)}`;
const LABELS = [...NOTES, ...DATES, LONG];
// No padding around the charts: a label past its chart’s edge must show as past the page’s.
// A chart of dates alone, where the digits’ width sets the margin.
const CHART = `<div id="bars"></div><div id="heat"></div><div id="dates"></div><script>
const cats = ${JSON.stringify(LABELS)};
postbox.charts.stacked(document.getElementById('bars'), {
  label: 'Passages per asset',
  categories: cats,
  series: [{ name: 'Passages', values: cats.map((_c, i) => 5 + i * 3) }],
});
postbox.charts.heatmap(document.getElementById('heat'), {
  label: 'Passages by week',
  rows: cats,
  cols: ['W1', 'W2', 'W3'],
  values: cats.map((_c, i) => [i, i + 1, i + 2]),
});
postbox.charts.stacked(document.getElementById('dates'), {
  label: 'Passages by day',
  categories: ${JSON.stringify(DATES)},
  series: [{ name: 'Passages', values: [3, 9, 4, 6] }],
});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
failOnServerErrors(test);
test.beforeAll(async () => {
  app = await startPostbox('kit-chart-labels');
  // The agent hears a failed check and doesn’t answer, so the app keeps what its first check found.
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});

test('long category labels on the kit’s bar chart and heatmap stay inside the page and pass the app check', async ({ browser }) => {
  test.setTimeout(60_000);
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Long labels',
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  rt.toolsFor(arrange.agentIn(rt, t.id).id).show_app({ id: 'labels', title: 'Passages per asset', code: CHART });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const check = () => rt.store.state.apps.labels.check;
  await expect.poll(() => check().status, { message: 'the app checked', timeout: 45_000 }).not.toBe('pending');
  const said = (check().problems ?? []).map((p) => `${p.code}: ${p.message}`).join('\n');
  expect(check().status, said || 'no problems').toBe('passed');
  const frame = page.frameLocator('iframe.app-iframe');
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(
        () =>
          frame
            .locator('svg')
            .evaluateAll((svgs) =>
              svgs.flatMap((s) =>
                [...s.querySelectorAll('text')].filter((t) => t.getBoundingClientRect().left < s.getBoundingClientRect().left).map((t) => t.textContent),
              ),
            ),
        { message: `no label starts past its chart’s left edge at ${width} px` },
      )
      .toEqual([]);
    for (const id of ['bars', 'heat']) await labelsNameEvery(frame, id, width);
  }
  await page.close();
});

/**
 * Each label on a chart shows whole, or, where it can’t fit, ends in “…” on a whole character with its full name in its
 * title. At 1280 px only the far longer one is cut.
 */
async function labelsNameEvery(frame, id, width) {
  const labels = await frame
    .locator(`#${id} svg text`)
    .evaluateAll(
      (ts, names) =>
        ts
          .map((t) => ({ shown: t.firstChild?.textContent ?? '', title: t.querySelector('title')?.textContent ?? null }))
          .filter((l) => l.title || names.includes(l.shown)),
      LABELS,
    );
  expect(
    labels.map((l) => l.title ?? l.shown),
    `#${id} at ${width} px names every asset`,
  ).toEqual(LABELS);
  for (const { shown, title } of labels.filter((l) => l.title)) {
    expect(shown, 'a cut label ends in “…”').toMatch(/…$/);
    expect(title.startsWith(shown.slice(0, -1)), `“${shown}” is the start of “${title}”`).toBe(true);
    // The long label’s cut lands among the families: each one before the “…” is whole.
    if (title === LONG) expect(shown.slice(1, -1).split(FAMILY).join(''), 'each family before the cut is whole').toBe('');
  }
  if (width === 1280)
    expect(
      labels.filter((l) => l.title).map((l) => l.title),
      `only the far longer label is cut in #${id}`,
    ).toEqual([LONG]);
}
