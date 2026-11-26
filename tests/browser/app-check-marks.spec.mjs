// #952: the pre-display check passed a chart whose band labels sat on its dots, rings and fit line, which hid values.
// Now it warns the agent of SVG text drawn over a chart’s marks, naming the labels. Labels placed clear of the marks, a
// count inside its own dot, a label with a halo that keeps it legible over a line, and axis labels beside their ticks
// pass. Every app goes up in one conversation, which a page opened before the tests checks.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

failOnPageErrors(test);

const T = 'fill="var(--text)" font-size="13"';
const DOTS = [
  [60, 200],
  [120, 170],
  [180, 150],
  [240, 120],
  [300, 100],
  [360, 70],
];
const dots = DOTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="var(--s1)"/>`).join('');
// A ring marking one run, standing alone.
const ring = '<circle cx="330" cy="190" r="12" fill="none" stroke="var(--s2)" stroke-width="2"/>';
// The fit line, drawn through its points as a series is.
const fit = '<path d="M40 215 L210 135 L380 55" fill="none" stroke="var(--s3)" stroke-width="2"/>';
const scatter = (id, labels) =>
  `<h2 style="color:var(--text);margin:8px">Runs got faster as sleep grew</h2><svg id="${id}" width="420" height="240" role="img" aria-label="Pace against sleep">${dots}${ring}${fit}${labels}</svg>`;

const APPS = {
  // The issue’s chart: “6:25” on a dot, “6:11” on the ring, “5:56” on the fit line; “Hill circuit” clear of them all.
  onmarks: scatter(
    'onmarks',
    `<text x="110" y="174" ${T}>6:25</text><text x="318" y="194" ${T}>6:11</text><text x="196" y="140" ${T}>5:56</text><text x="20" y="40" ${T}>Hill circuit</text>`,
  ),
  // The same labels placed clear: above and beside the marks.
  clear: scatter(
    'clear',
    `<text x="100" y="150" ${T}>6:25</text><text x="262" y="142" ${T}>6:11</text><text x="300" y="232" ${T}>5:56</text><text x="20" y="40" ${T}>Hill circuit</text>`,
  ),
  // A count inside each dot, as a bubble chart writes it.
  counts: `<svg id="counts" width="300" height="100" role="img" aria-label="Counts">${[60, 150, 240]
    .map(
      (x, i) =>
        `<circle cx="${x}" cy="50" r="11" fill="var(--s1)"/><text x="${x}" y="54" text-anchor="middle" fill="var(--on-ink)" font-size="11">${2 + i}</text>`,
    )
    .join('')}</svg>`,
  // A label over the line with a halo in the background’s color, which keeps it legible there.
  halo: `<svg id="halo" width="420" height="240" role="img" aria-label="Fit">${fit}<text x="196" y="140" ${T} stroke="var(--bg)" stroke-width="4" paint-order="stroke">5:56</text></svg>`,
  // A diagram’s nodes, big circles whose names spill past them, and a label on a straight edge between two of them.
  nodes: `<svg id="nodes" width="420" height="120" role="img" aria-label="Steps"><path d="M70 60 L330 60" stroke="var(--text)" stroke-width="2"/><circle cx="70" cy="60" r="30" fill="var(--s1)"/><circle cx="330" cy="60" r="30" fill="var(--s2)"/><text x="40" y="64" ${T}>Committee review</text><text x="180" y="64" ${T}>passes</text></svg>`,
  // A label on a backing over the line: the backing keeps the line from showing through it.
  backed: `<svg id="backed" width="420" height="240" role="img" aria-label="Fit">${fit}<rect x="192" y="127" width="34" height="17" fill="var(--bg)"/><text x="196" y="140" ${T}>5:56</text></svg>`,
  // An axis as d3 draws one: its domain path, tick lines, and tick labels beside them, and its title on the line.
  axes: `<svg id="axes" width="420" height="80" role="img" aria-label="Hours"><g class="axis" transform="translate(20,20)"><path class="domain" d="M0 6 V0 H360 V6" stroke="var(--text)" fill="none"/>${[
    0, 90, 180, 270, 360,
  ]
    .map(
      (x, i) =>
        `<g class="tick" transform="translate(${x},0)"><line y2="6" stroke="var(--line-strong)"/><text y="4" text-anchor="middle" ${T}>${5 + i}h</text></g>`,
    )
    .join('')}</g><text x="170" y="25" ${T}>Hours</text></svg>`,
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  app = await startPostbox('app-check-marks');
  const { rt } = app;
  arrange.withAdapter(rt, { name: 'mock', async deliver() {} });
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Marks',
    personaIds: [rt.createPersona({ handle: 'drawer' }).id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  for (const [id, code] of Object.entries(APPS)) tools.show_app({ id, title: id, code });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect
    .poll(() => Object.keys(APPS).filter((id) => rt.store.state.apps[id].check.status === 'pending'), { message: 'every app checked', timeout: 90_000 })
    .toEqual([]);
  await page.close();
});
test.afterAll(async () => {
  await app?.stop();
});

const check = (id) => app.rt.store.state.apps[id].check;
const says = (id) => (check(id).problems ?? []).map((p) => `${p.code}: ${p.message}`).join('\n') || 'no problems';
const overMarks = (id) => (check(id).problems ?? []).filter((p) => p.code === 'text-over-marks').map((p) => p.message);

test('#952 labels drawn over a chart’s dot, ring and fit line are a warning that names them, and the chart still shows', () => {
  const [message] = overMarks('onmarks');
  expect(message, says('onmarks')).toMatch(/^In svg#onmarks, 3 labels sit on the chart’s marks/);
  expect(message).toContain('“6:25” (on a dot)');
  expect(message).toContain('“6:11” (on a ring)');
  expect(message).toContain('“5:56” (on a line)');
  expect(message).not.toContain('Hill circuit');
  expect(check('onmarks').status, 'a warning: the version is shown, with a note').toBe('note');
});

for (const id of ['clear', 'counts', 'nodes', 'halo', 'backed', 'axes'])
  test(`#952 ${id}: text that doesn’t hide a mark passes`, () => {
    expect(overMarks(id), says(id)).toEqual([]);
  });
