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
// The fit line, a straight line of two points, as a fit almost always is.
const fit = '<path d="M40 215 L380 55" fill="none" stroke="var(--s3)" stroke-width="2"/>';
// Scaled to fit a narrow pane, so the 375 px frame finds no overflow, and the only finding is the labels’.
const scatter = (id, labels) =>
  `<h2 style="color:var(--text);margin:8px">Runs got faster as sleep grew</h2><svg id="${id}" width="420" height="240" viewBox="0 0 420 240" style="max-width:100%;height:auto" role="img" aria-label="Pace against sleep">${dots}${ring}${fit}${labels}</svg>`;

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
  halo: `<svg id="halo" width="420" height="240" role="img" aria-label="Fit">${dots}${fit}<text x="196" y="140" ${T} stroke="var(--bg)" stroke-width="4" paint-order="stroke">5:56</text></svg>`,
  // A diagram’s nodes, big circles whose names spill past them, and a label on a straight edge between two of them.
  nodes: `<svg id="nodes" width="420" height="120" role="img" aria-label="Steps"><path d="M70 40 L330 80" stroke="var(--text)" stroke-width="2"/><circle cx="70" cy="40" r="30" fill="var(--s1)"/><circle cx="330" cy="80" r="30" fill="var(--s2)"/><text x="40" y="44" ${T}>Committee review</text><text x="180" y="65" ${T}>passes</text></svg>`,
  // A scatter with a dot drawn faint, in a group at a fifth of full opacity, for context, under a label.
  faint: `<svg id="faint" width="420" height="240" role="img" aria-label="Runs">${dots}<g opacity="0.2"><circle cx="320" cy="200" r="6" fill="var(--s1)"/></g><text x="306" y="204" ${T}>Last year</text></svg>`,
  // The same clipped line with a label on its visible part, in the plot: that one is on the line.
  clippedOn: `<svg id="clippedOn" width="420" height="260" role="img" aria-label="Runs"><defs><clipPath id="plot2"><rect x="40" y="10" width="360" height="210"/></clipPath></defs>${dots}<path d="M0 260 L420 0" stroke="var(--text)" stroke-width="2" clip-path="url(#plot2)"/><text x="200" y="140" ${T}>Break-even</text></svg>`,
  // A line clipped in its own box’s units, which the check doesn’t place: it’s tested whole, so a label on it is on it.
  boxClip: `<svg id="boxClip" width="420" height="260" role="img" aria-label="Runs"><defs><clipPath id="box" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="1" height="1"/></clipPath></defs>${dots}<path d="M0 260 L420 0" stroke="var(--text)" stroke-width="2" clip-path="url(#box)"/><text x="200" y="140" ${T}>Break-even</text></svg>`,
  // A scatter of open rings, with its two-point fit line under a label: rings make it a chart too.
  rings: `<svg id="rings" width="420" height="240" role="img" aria-label="Runs">${DOTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="var(--s1)" stroke-width="2"/>`).join('')}${fit}<text x="196" y="140" ${T}>5:56</text></svg>`,
  // A scatter whose reference line runs past its plot, clipped there, with the axis title under the hidden part.
  clipped: `<svg id="clipped" width="420" height="260" role="img" aria-label="Runs"><defs><clipPath id="plot"><rect x="40" y="10" width="360" height="210"/></clipPath></defs>${dots}<path d="M0 260 L420 0" stroke="var(--text)" stroke-width="2" clip-path="url(#plot)"/><text x="10" y="252" ${T}>Hours</text></svg>`,
  // A scatter with a level gridline under a label: a gridline isn’t a mark.
  grid: `<svg id="grid" width="420" height="240" role="img" aria-label="Runs">${dots}<line x1="40" y1="30" x2="400" y2="30" stroke="var(--text)"/><text x="150" y="34" ${T}>Fastest runs</text></svg>`,
  // A label on a backing over the line: the backing keeps the line from showing through it.
  backed: `<svg id="backed" width="420" height="240" role="img" aria-label="Fit">${dots}${fit}<rect x="192" y="127" width="34" height="17" fill="var(--bg)"/><text x="196" y="140" ${T}>5:56</text></svg>`,
  // A dot reaching into the top of a label’s box, above its letters: it grazes the label without hiding it.
  grazed: `<svg id="grazed" width="420" height="240" role="img" aria-label="Runs">${dots}<text x="150" y="166.5" ${T}>Morning</text></svg>`,
  // The same graze in an SVG stretched twice as tall as its viewBox, with dots small enough to stay dots once
  // stretched: the band scales with the vertical axis.
  stretched: `<svg id="stretched" width="420" height="480" viewBox="0 0 420 240" preserveAspectRatio="none" role="img" aria-label="Runs">${DOTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5" fill="var(--s1)"/>`).join('')}<text x="150" y="164.5" ${T}>Morning</text></svg>`,
  // A rounded box drawn as a path, its stroke under the ends of the name centered in it.
  rounded: `<svg id="rounded" width="200" height="120" role="img" aria-label="Steps"><path d="M50 30 H150 A10 10 0 0 1 160 40 V80 A10 10 0 0 1 150 90 H50 A10 10 0 0 1 40 80 V40 A10 10 0 0 1 50 30 Z" fill="none" stroke="var(--s1)" stroke-width="4"/><text x="100" y="64" text-anchor="middle" textLength="120" lengthAdjust="spacingAndGlyphs" ${T}>Committee review</text></svg>`,
  // A diagram’s node, a hexagon whose slanted sides cut into the corners of the name it holds.
  named: `<svg id="named" width="200" height="120" role="img" aria-label="Steps"><path d="M40 60 L60 30 H140 L160 60 L140 90 H60 Z" fill="none" stroke="var(--s1)" stroke-width="4"/><text x="100" y="64" text-anchor="middle" textLength="116" lengthAdjust="spacingAndGlyphs" ${T}>Committee review</text></svg>`,
  // A three-line callout with a dot on its first line, in that line’s own band.
  callout: `<svg id="callout" width="420" height="120" role="img" aria-label="Weeks"><circle cx="270" cy="34" r="4" fill="var(--s1)"/><text x="250" y="40" ${T}><tspan x="250">Best week</tspan><tspan x="250" dy="16">of the year,</tspan><tspan x="250" dy="16">after rest</tspan></text></svg>`,
  // A week’s sparkline drawn as a small closed area, its last value printed on its top edge, off its middle: not its name.
  spark: `<svg id="spark" width="200" height="90" role="img" aria-label="Visits"><path d="M10 60 L30 20 L50 44 L70 30 L90 46 L110 34 L130 40 L150 38 L150 70 L10 70 Z" fill="none" stroke="var(--s1)" stroke-width="2"/><text x="128" y="45" ${T}>42</text></svg>`,
  // A region larger than a node, its edge a line, with a label inside its box on that edge.
  region: `<svg id="region" width="420" height="240" role="img" aria-label="Costs"><path d="M20 220 L400 220 L400 20 Z" fill="none" stroke="var(--s2)" stroke-width="2"/><text x="200" y="125" ${T}>Forbidden</text></svg>`,
  // A halo as d3’s examples draw one: a stroked copy of the label behind it, which keeps it legible over the line.
  haloCopy: `<svg id="haloCopy" width="420" height="240" role="img" aria-label="Fit">${dots}${fit}<text x="196" y="140" ${T} stroke="var(--bg)" stroke-width="4">5:56</text><text x="196" y="140" ${T}>5:56</text></svg>`,
  // Gridlines drawn as one path, a level stroke to each subpath, under a label.
  gridPath: `<svg id="gridPath" width="420" height="240" role="img" aria-label="Runs">${dots}<path d="M40 30H400M40 90H400" stroke="var(--text)"/><text x="150" y="34" ${T}>Fastest runs</text></svg>`,
  // A panel on its own background, with a label on one of its dots: the background is under the dot, so it hides nothing.
  panel: `<svg id="panel" width="420" height="240" role="img" aria-label="Runs"><rect x="10" y="10" width="200" height="110" fill="var(--bg)"/><circle cx="60" cy="60" r="6" fill="var(--s1)"/><text x="50" y="64" ${T}>Peak</text></svg>`,
  // Four charts, each with a label on a dot: the check names three, so its findings never crowd out the rest.
  four: [1, 2, 3, 4]
    .map(
      (i) =>
        `<svg id="four${i}" width="200" height="80" role="img" aria-label="Runs"><circle cx="60" cy="40" r="6" fill="var(--s1)"/><text x="50" y="44" ${T}>Peak</text></svg>`,
    )
    .join(''),
  // A tick label rotated −45°, with a dot in the empty corner of its box on screen, clear of its letters.
  rotated: `<svg id="rotated" width="300" height="160" role="img" aria-label="Runs"><text x="100" y="100" transform="rotate(-45 100 100)" ${T}>September</text><circle cx="104" cy="60" r="4" fill="var(--s1)"/></svg>`,
  // The same rotated label with a dot on its letters: on the dot.
  rotatedOn: `<svg id="rotatedOn" width="300" height="160" role="img" aria-label="Runs"><text x="100" y="100" transform="rotate(-45 100 100)" ${T}>September</text><circle cx="121" cy="75" r="5" fill="var(--s1)"/></svg>`,
  // Data dots in a group whose id starts with “key”, and labels on them: a key is furniture, “key-events” isn’t.
  keyGroup: `<svg id="keyGroup" width="300" height="120" role="img" aria-label="Events"><g id="key-events"><circle cx="60" cy="60" r="6" fill="var(--s1)"/><text x="50" y="64" ${T}>Launch</text></g></svg>`,
  // An axis in a group named “x-axis”, its title on its line: furniture, with its prefix.
  xAxis: `<svg id="xAxis" width="420" height="80" role="img" aria-label="Hours"><g class="x-axis"><path d="M20 26 V20 H380 V26" stroke="var(--text)" fill="none"/></g><text x="170" y="25" ${T}>Hours</text></svg>`,
  // A chart heavy enough to take the check past its time: 10 series of 3,000 points, each starting at the top corner
  // and ending at the bottom one, so its box covers the plot, and 200 labels in the gaps between the lines, clear of
  // them. Every label is tested against every series, point by point. The check stops looking at its budget, so the
  // frame still answers.
  heavy: `<svg id="heavy" width="800" height="420" role="img" aria-label="Load">${Array.from({ length: 10 }, (_, s) => {
    const y = 40 + s * 36;
    const wave = Array.from({ length: 3000 }, (_, i) => ` L${(20 + i * 0.25).toFixed(1)} ${(y + Math.sin(i / 21) * 2).toFixed(1)}`).join('');
    return `<path d="M0 0 L0 ${y}${wave} L800 ${y} L800 420" fill="none" stroke="var(--s1)" stroke-width="1"/>`;
  }).join(
    '',
  )}${Array.from({ length: 200 }, (_, i) => `<text x="${40 + (i % 20) * 37}" y="${62 + Math.floor(i / 20) * 36}" font-size="11" fill="var(--text)">Run ${i}</text>`).join('')}</svg>`,
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
// What the agent alone is told: the check’s hints, beside its problems (#952).
const found = (id) => [...(check(id).problems ?? []), ...(check(id).hints ?? [])];
const says = (id) =>
  found(id)
    .map((p) => `${p.code}: ${p.message}`)
    .join('\n') || 'no problems';
const overMarks = (id) =>
  found(id)
    .filter((p) => p.code === 'text-over-marks')
    .map((p) => p.message);

test('#952 labels drawn over a chart’s dot, ring and fit line are a hint for the agent that names them', () => {
  const [message] = overMarks('onmarks');
  expect(message, says('onmarks')).toMatch(/^In svg#onmarks, 3 labels sit on the chart’s marks/);
  expect(message).toContain('“6:25” (on a dot)');
  expect(message).toContain('“6:11” (on a ring)');
  expect(message).toContain('“5:56” (on a line)');
  expect(message).not.toContain('Hill circuit');
  // What to do comes before the labels, which the server’s cut at 300 characters can reach.
  expect(message.indexOf('Place each')).toBeLessThan(message.indexOf('“6:25”'));
  // Not its status: a label on a dot’s fill can also fail contrast, depending on where the platform’s font puts it,
  // and that finding is the person’s.
});

test('#952 the person sees the chart with no note: only its agent hears of the labels on its marks', async ({ page }) => {
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Chart',
    personaIds: [rt.createPersona({ handle: 'charter' }).id],
  });
  // Its only finding is a label on the fit line: nothing else could give the version a note.
  const code = scatter('quiet', `<text x="196" y="140" ${T}>5:56</text>`);
  rt.toolsFor(arrange.agentIn(rt, t.id).id).show_app({ id: 'quiet', title: 'quiet', code });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect.poll(() => rt.store.state.apps.quiet.check.status, { message: 'the chart checked', timeout: 30_000 }).not.toBe('pending');
  expect(check('quiet').status, says('quiet')).toBe('passed');
  expect(check('quiet').problems, 'nothing for the person').toEqual([]);
  expect(overMarks('quiet'), 'its agent hears of the labels').toHaveLength(1);
  const item = page.locator(`#main [data-key="${rt.store.state.apps.quiet.itemId}"]`);
  await expect(item.locator('iframe.app-iframe'), 'the chart is shown').toBeVisible();
  await expect(item.locator('.app-note'), 'with no note').toHaveCount(0);
});

test('#952 a label on the visible part of a clipped line, on a ring scatter’s fit line, and on a line clipped in its box’s units, is on the line', () => {
  expect(overMarks('clippedOn')[0], says('clippedOn')).toMatch(/“Break-even” \(on a line\)/);
  expect(overMarks('rings')[0], says('rings')).toMatch(/“5:56” \(on a line\)/);
  expect(overMarks('boxClip')[0], says('boxClip')).toMatch(/“Break-even” \(on a line\)/);
});

test('#952 a label on the edge of a region larger than a node, or of a small area chart, is on a line: only a node’s name is its own', () => {
  expect(overMarks('region')[0], says('region')).toMatch(/“Forbidden” \(on a line\)/);
  expect(overMarks('spark')[0], says('spark')).toMatch(/“42” \(on a line\)/);
});

test('#952 a dot on the first line of a three-line callout is under it', () => {
  // The warning quotes the label’s lines joined with a space, as the person reads them.
  expect(overMarks('callout')[0], says('callout')).toContain('“Best week of the year, after rest” (on a dot)');
});

test('#952 a rotated label is tested on its letters: a dot on them is under it, one in its box’s empty corner isn’t', () => {
  expect(overMarks('rotatedOn')[0], says('rotatedOn')).toMatch(/“September” \(on a dot\)/);
  expect(overMarks('rotated'), says('rotated')).toEqual([]);
});

test('#952 a label on a data dot in a group named “key-events” is on the dot: only a whole key is furniture', () => {
  expect(overMarks('keyGroup')[0], says('keyGroup')).toMatch(/“Launch” \(on a dot\)/);
});

test('#952 a chart too heavy to finish in the check’s time still gets an answer: the check stops looking at its budget', () => {
  expect(
    (check('heavy').problems ?? []).map((p) => p.code),
    says('heavy'),
  ).not.toContain('no-answer');
});

test('#952 a label on a dot over a panel’s background is on the dot, and four such charts give three findings', () => {
  expect(overMarks('panel')[0], says('panel')).toMatch(/“Peak” \(on a dot\)/);
  expect(overMarks('four'), says('four')).toHaveLength(3);
});

for (const id of [
  'clear',
  'counts',
  'nodes',
  'faint',
  'clipped',
  'grid',
  'halo',
  'haloCopy',
  'gridPath',
  'backed',
  'axes',
  'grazed',
  'stretched',
  'named',
  'rounded',
  'rotated',
  'xAxis',
])
  test(`#952 ${id}: text that doesn’t hide a mark passes`, () => {
    expect(overMarks(id), says(id)).toEqual([]);
  });
