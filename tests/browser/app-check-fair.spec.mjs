// What the readability checks of #997 must not hold back, from the review of #1008: apps a person can read. Every app
// goes up in one conversation, which a page opened before the tests checks; each test reads what the check found.
// - Contrast: a label the check can’t measure the background of is left unjudged (a gradient, a shape drawn by <use>,
//   a label in a box that scrolls sideways), and one on a solid shape or a thick route line is measured against it.
//   One that is too faint on its shape is told to change its ink for that fill, never to use the page’s text color.
// - The kit’s own styles meet the 12 px floor in an app: kbd and every class the guide offers.
// - Text in boxes: a chart’s marks that carry its values aren’t boxes holding names (a treemap, a Gantt chart, bars with
//   their names inside), nor is a backing the color of the page behind a label, nor a legend’s frame.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

failOnPageErrors(test);

// White labels on a dark navy shape, drawn several ways; navy and white are about 14:1.
const ON = 'fill="#ffffff" font-size="14"';
const TEXT = 'fill="var(--text)" font-size="14"';
const APPS = {
  gradient: `<svg width="320" height="80" role="img" aria-label="Gradient"><defs><linearGradient id="g"><stop offset="0" stop-color="#14213d"/><stop offset="1" stop-color="#1d3557"/></linearGradient></defs>
<rect x="0" y="0" width="300" height="60" fill="url(#g)"/><text x="16" y="36" ${ON}>Peak demand</text></svg>`,
  use: `<svg width="320" height="80" role="img" aria-label="Use"><defs><rect id="node" width="300" height="60" fill="#14213d"/></defs>
<use href="#node" x="0" y="0"/><text x="16" y="36" ${ON}>Peak demand</text></svg>`,
  route: `<svg width="320" height="80" role="img" aria-label="Route"><path d="M0 40 H300" stroke="#14213d" stroke-width="30" fill="none"/><text x="16" y="45" ${ON}>Main line</text></svg>`,
  solid: `<svg width="320" height="80" role="img" aria-label="Solid"><rect x="0" y="0" width="300" height="60" fill="#14213d"/><text x="16" y="36" ${ON}>Peak demand</text></svg>`,
  // An 800 px SVG in a box that scrolls sideways: at 375 px its last label is off to the side, where the page can’t
  // scroll to it, and at 1280 px it shows on its navy shape.
  scroller: `<div style="overflow-x:auto;max-width:100%"><svg width="800" height="80" role="img" aria-label="Wide"><rect x="560" y="0" width="230" height="60" fill="#14213d"/><text x="576" y="36" ${ON}>Peak demand</text></svg></div>`,
  // A label on the page with a dark hairline crossing its middle: the page is behind most of it.
  crossed: `<svg width="320" height="80" role="img" aria-label="Crossed"><line x1="0" y1="31" x2="300" y2="31" stroke="#14213d"/><text x="16" y="36" fill="var(--text)" font-size="14">Peak demand</text></svg>`,
  // Navy text on a navy shape: too faint, and told to change its ink for that fill.
  faint: `<svg width="320" height="80" role="img" aria-label="Faint"><rect class="band" x="0" y="0" width="300" height="60" fill="#14213d"/><text x="16" y="36" fill="#2b3f66" font-size="14">Peak demand</text></svg>`,
  // A treemap of spending: six tiles whose sizes are the values, with their names inside.
  treemap: `<svg width="340" height="240" role="img" aria-label="Spending">${[
    [0, 0, 180, 120, 'Housing'],
    [180, 0, 160, 120, 'Food'],
    [0, 120, 120, 120, 'Transport'],
    [120, 120, 110, 120, 'Health'],
    [230, 120, 110, 60, 'Leisure'],
    [230, 180, 110, 60, 'Gifts'],
  ]
    .map(
      ([x, y, w, h, k]) =>
        `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" fill="var(--panel)" stroke="var(--line-strong)"/><text x="${x + 8}" y="${y + 22}" ${TEXT}>${k}</text>`,
    )
    .join('')}</svg>`,
  // A Gantt chart: six spans whose lengths are their durations, each named inside.
  gantt: `<svg width="340" height="220" role="img" aria-label="Plan">${[
    [10, 120, 'Design'],
    [40, 100, 'Review'],
    [100, 160, 'Build'],
    [230, 90, 'Test'],
    [150, 140, 'Launch'],
    [280, 50, 'Ship'],
  ]
    .map(
      ([x, w, k], i) =>
        `<rect x="${x}" y="${i * 36 + 4}" width="${w}" height="28" fill="var(--panel)" stroke="var(--line-strong)"/><text x="${x + 8}" y="${i * 36 + 23}" ${TEXT}>${k}</text>`,
    )
    .join('')}</svg>`,
  // Bars whose lengths are the values, with their names inside.
  bars: `<svg width="340" height="210" role="img" aria-label="Spending by category">${[
    ['Rent', 300],
    ['Dining', 250],
    ['Food', 200],
    ['Travel', 160],
    ['Bills', 130],
  ]
    .map(
      ([k, v], i) =>
        `<rect x="10" y="${i * 40 + 4}" width="${v}" height="30" fill="var(--panel)" stroke="var(--line-strong)"/><text x="18" y="${i * 40 + 24}" ${TEXT}>${k}</text>`,
    )
    .join('')}</svg>`,
  // A graph of five modules, named beside their dots, with each edge’s label on a backing the color of the page.
  backing: `<svg width="340" height="220" role="img" aria-label="Modules">${[
    [40, 40, 'server', 170, 40, 'imports'],
    [170, 40, 'store', 300, 110, 'writes'],
    [300, 110, 'files', 170, 180, 'reads'],
    [170, 180, 'client', 40, 110, 'calls'],
    [40, 110, 'pages', 40, 40, 'loads'],
  ]
    .map(
      ([x1, y1, k, x2, y2, e]) =>
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--line-strong)"/><circle cx="${x1}" cy="${y1}" r="7" fill="var(--accent)"/><text x="${x1 + 12}" y="${y1 - 10}" ${TEXT}>${k}</text><rect x="${(x1 + x2) / 2 - 26}" y="${(y1 + y2) / 2 - 11}" width="52" height="20" fill="var(--bg)"/><text x="${(x1 + x2) / 2 - 22}" y="${(y1 + y2) / 2 + 4}" ${TEXT}>${e}</text>`,
    )
    .join('')}</svg>`,
  // A line chart with its legend of line keys in a frame.
  legend: `<svg width="340" height="220" role="img" aria-label="Income"><polyline points="10,150 90,120 170,110 250,80 330,60" fill="none" stroke="var(--s1)" stroke-width="2"/><polyline points="10,170 90,150 170,145 250,120 330,105" fill="none" stroke="var(--s2)" stroke-width="2"/>
<rect class="key" x="10" y="4" width="320" height="50" fill="none" stroke="var(--line-strong)"/><line x1="20" y1="20" x2="40" y2="20" stroke="var(--s1)" stroke-width="2"/><text x="48" y="25" ${TEXT}>Median household income in dollars</text><line x1="20" y1="42" x2="40" y2="42" stroke="var(--s2)" stroke-width="2"/><text x="48" y="47" ${TEXT}>Mean household income</text></svg>`,
  kit: `<div style="padding:12px;color:var(--text)"><h2 style="margin:0 0 8px">Kit sampler</h2>
<p>Press <kbd>→</kbd> to step. <span class="dim">Dim</span>, <span class="small">small</span>, <span class="mono">mono</span> and <span class="pill">pill</span>.</p>
<div class="label">Section label</div>
<label class="field"><span class="label">Name</span><input class="input" value="Ada"></label> <select class="select" aria-label="Book"><option>Emma</option></select>
<p><button class="btn" type="button">Run</button> <button class="btn sm" type="button">Small</button> <button class="btn ghost" type="button">Cancel</button> <button class="btn primary" type="button">Go</button></p>
<p><button class="chip" type="button" aria-pressed="true">1850s</button> <button class="chip sm" type="button" aria-pressed="false">1860s</button></p>
<div class="seg" role="group" aria-label="Corpus"><button type="button" aria-pressed="true">Novels</button><button type="button" aria-pressed="false">Letters</button></div>
<table class="tbl"><tr><th>Book</th><th>Passages</th></tr><tr><td>Emma</td><td>812</td></tr></table></div>`,
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  app = await startPostbox('app-check-fair');
  const { rt } = app;
  // The agent hears a failed check and doesn’t answer, so each app keeps what its first check found.
  rt.adapters.register({ name: 'mock', async deliver() {} });
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: 'Fair', personaIds: [rt.createPersona({ handle: 'drawer' }).id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  for (const [id, code] of Object.entries(APPS)) tools.show_app({ id, title: id, code });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect
    .poll(() => Object.keys(APPS).filter((id) => rt.s.apps[id].check.status === 'pending'), { message: 'every app checked', timeout: 90_000 })
    .toEqual([]);
  await page.close();
});
test.afterAll(async () => {
  await app?.stop();
});

const check = (id) => app.rt.s.apps[id].check;
const says = (id) => (check(id).problems ?? []).map((p) => `${p.code}: ${p.message}`).join('\n') || 'no problems';

for (const [id, what] of [
  ['gradient', 'a white label on a gradient'],
  ['use', 'a white label on a shape drawn by <use>'],
  ['route', 'a white label on a thick route line'],
  ['solid', 'a white label on a navy shape'],
  ['scroller', 'a white label in a box that scrolls sideways'],
  ['crossed', 'a label with a hairline crossing its middle'],
])
  test(`#997 ${what} passes`, () => {
    expect(check(id).status, says(id)).toBe('passed');
  });

for (const [id, what] of [
  ['treemap', 'a treemap with its names inside its tiles'],
  ['gantt', 'a Gantt chart with its tasks named inside their spans'],
  ['bars', 'a bar chart with its names inside its bars'],
  ['backing', 'edge labels on backings the color of the page'],
  ['legend', 'a legend of line keys in a frame'],
])
  test(`#997 ${what} isn’t text in boxes, and passes`, () => {
    expect(check(id).status, says(id)).toBe('passed');
  });

test('#997 kbd and the kit’s classes in an app are 12 px or more, and pass', () => {
  expect(check('kit').status, says('kit')).toBe('passed');
});

test('#997 navy text on a navy shape is low contrast, and told to change its ink for that fill', () => {
  const [low] = (check('faint').problems ?? []).filter((p) => p.code === 'contrast');
  expect(low?.message, says('faint')).toMatch(
    /^Text “Peak demand” \([^)]*\) has contrast 1\.\d+:1 with the fill of [^;]*rect\.band; it needs 4\.5:1\. Set dark text on a light fill/,
  );
  expect(low.message).not.toMatch(/var\(--text\)/);
});
