// The pre-display check holds back a visual that can’t be read, and tells the agent which elements to fix (#997): text
// in boxes (an accent strip on each box too, and a Mermaid flowchart) and a sentence in a box, text under 12 px, low
// contrast on an SVG label, a label cut off by its SVG’s edge, labels drawn over each other, and a figure below the
// first view at 1000 × 680. A chart whose labels sit beside its marks, a legend’s swatches, and a page that shows its
// title and figure at once pass. Every app goes up in one conversation, which a page opened before the tests checks;
// each test reads what the check found, and what the agent was sent.

import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

failOnPageErrors(test);

const T = 'fill="var(--text)" font-size="14"';
// A flowchart of named boxes, as Mermaid draws one: five boxes joined by arrows, one of them holding a sentence.
const STEPS = ['Read file', 'Parse rows', 'Check totals', 'Write temp', 'Swap in'];
const flow = `<h2 style="color:var(--text);margin:8px">How a save works</h2>
<svg id="flow" width="760" height="120" role="img" aria-label="Save steps">${STEPS.map(
  (s, i) =>
    `<rect class="node" x="${10 + i * 150}" y="20" width="120" height="44" rx="6" fill="var(--panel)" stroke="var(--line-strong)"/><text x="${22 + i * 150}" y="47" ${T}>${s}</text>`,
).join(
  '',
)}<rect class="note" x="10" y="74" width="740" height="40" fill="var(--panel)" stroke="var(--line-strong)"/><text x="20" y="99" ${T}>Every row is checked before the old file is replaced on disk</text></svg>`;

// The same flowchart with a 4 px accent strip down each box’s left edge.
const accent = `<svg id="accent" width="760" height="70" role="img" aria-label="Save steps">${STEPS.map(
  (s, i) =>
    `<rect x="${10 + i * 150}" y="10" width="120" height="44" rx="6" fill="var(--panel)" stroke="var(--line-strong)"/><rect x="${10 + i * 150}" y="10" width="4" height="44" fill="var(--accent)"/><text x="${22 + i * 150}" y="37" ${T}>${s}</text>`,
).join('')}</svg>`;

// A bar chart: names beside the bars, values inside them (numbers, not names), and a legend of swatches beside names.
const BARS = [
  ['Rent', 320],
  ['Dining out', 180],
  ['Groceries', 140],
  ['Transport', 90],
  ['Utilities', 60],
];
const chart = `<h2 style="color:var(--text);margin:8px">Rent and dining out drove the rise</h2>
<svg id="bars" width="340" height="260" role="img" aria-label="Spending by category">${BARS.map(
  ([k, v], i) =>
    `<text x="10" y="${34 + i * 40}" ${T}>${k}</text><rect x="110" y="${16 + i * 40}" width="${v * 0.6}" height="28" fill="var(--accent)"/><text x="${116}" y="${35 + i * 40}" fill="var(--on-ink)" font-size="13">${v}</text>`,
).join(
  '',
)}<rect x="110" y="226" width="14" height="14" fill="var(--accent)"/><text x="130" y="238" ${T}>This year</text><rect x="230" y="226" width="14" height="14" fill="var(--dim)"/><text x="250" y="238" ${T}>Last year</text></svg>`;

// A flowchart whose boxes come in two widths, as a diagram’s do: not bars of different lengths.
const WIDTHS = [185, 185, 117, 185, 117, 185];
const twosizes = `<svg id="twosizes" width="1160" height="70" role="img" aria-label="Bill’s path">${[
  'Introduced',
  'Committee',
  'Vote',
  'Second chamber',
  'Signs',
  'Becomes law',
]
  .map((s, i) => {
    const x = 10 + WIDTHS.slice(0, i).reduce((a, b) => a + b + 12, 0);
    return `<rect x="${x}" y="10" width="${WIDTHS[i]}" height="45" fill="var(--panel)" stroke="var(--line-strong)"/><text x="${x + 10}" y="37" ${T}>${s}</text>`;
  })
  .join('')}</svg>`;

const APPS = {
  flow,
  accent,
  twosizes,
  // The same steps as a Mermaid flowchart, whose labels are HTML in each node’s foreignObject.
  mermaid: `<div id="m"></div><script>
postbox.load('mermaid').then((mermaid) => {
  mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
  return mermaid.render('flow-m', 'flowchart LR\\n  A[Read file] --> B[Parse rows] --> C[Check totals] --> D[Write temp] --> E[Swap in]');
}).then(({ svg }) => { document.getElementById('m').innerHTML = svg; });
</script>`,
  chart,
  // Page text at 10 px, and an SVG label drawn at 9 px.
  small: `<div style="padding:12px;color:var(--text)"><h2 style="margin:0">Where the time went</h2><p class="fine" style="font-size:10px">Source: the team’s timesheets</p>
<svg width="300" height="60" role="img" aria-label="Hours"><circle cx="20" cy="30" r="8" fill="var(--accent)"/><text class="tick" x="36" y="34" fill="var(--text)" font-size="9">Meetings</text></svg></div>`,
  // A pale label on a pale box in an SVG: the page behind the SVG is dark, the box under the label is light.
  pale: `<svg width="320" height="80" role="img" aria-label="Status"><rect x="0" y="0" width="200" height="60" fill="#ffffff"/><text id="pale-label" x="12" y="36" fill="#d0d0d0" font-size="16">Waiting on review</text></svg>`,
  // A label running past the right edge of its SVG, which cuts it off.
  cut: `<svg width="200" height="60" role="img" aria-label="Edge"><circle cx="150" cy="30" r="6" fill="var(--accent)"/><text class="end" x="162" y="34" ${T}>Peak in March</text></svg>`,
  // Two labels drawn over each other.
  overlap: `<svg width="320" height="60" role="img" aria-label="Labels"><text class="a" x="20" y="30" ${T}>Median income</text><text class="b" x="30" y="34" ${T}>Mean income</text></svg>`,
  // The title, then a block of notes 700 px tall, then the figure: at 1000 × 680, none of the figure shows.
  below: `<h1 style="color:var(--text);margin:8px">Sleep sets the pace</h1><div class="notes" style="height:700px;color:var(--text)">Notes</div>
<svg id="pace" width="600" height="300" role="img" aria-label="Pace"><circle cx="300" cy="150" r="40" fill="var(--accent)"/></svg>`,
  // The title and a 400 px figure 340 px wide, with its labels at 12 px and over beside its marks: everything shows at once.
  good: `<h1 style="color:var(--text);margin:8px;font-size:22px">Sleep sets the pace</h1>
<svg width="340" height="400" role="img" aria-label="Pace by sleep">${[0, 1, 2, 3]
    .map(
      (i) =>
        `<circle cx="${20 + i * 75}" cy="${300 - i * 60}" r="8" fill="var(--accent)"/><text x="${32 + i * 75}" y="${304 - i * 60}" ${T}>${6 + i} hours</text>`,
    )
    .join('')}</svg>`,
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What each app’s agent was sent about its check, by app id. */
const sent = {};
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  app = await startPostbox('app-check-readable');
  const { rt } = app;
  // The agent hears a failed check and doesn’t answer, so each app keeps what its first check found.
  rt.adapters.register({
    name: 'mock',
    async deliver(_s, message) {
      if (message.kind === 'app-check') sent[message.appId] = message.problems;
    },
  });
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: 'Readable', personaIds: [rt.createPersona({ handle: 'drawer' }).id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  for (const [id, code] of Object.entries(APPS)) tools.show_app({ id, title: id, code });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
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
/**
 * The messages of one code the agent was sent, once: the check held the version back for the agent to fix. (Its mock
 * turn ends without a new version, so the app is shown with a note after.)
 */
function heldFor(id, code) {
  expect.soft(check(id).attempt, `${id} went back to the agent once: ${says(id)}`).toBe(1);
  return (sent[id] ?? []).filter((p) => p.code === code).map((p) => p.message);
}

test('#997 a flowchart of named boxes is held back as text in boxes, naming the boxes’ labels', () => {
  const [boxes] = heldFor('flow', 'text-in-boxes');
  expect(boxes, says('flow')).toMatch(/In svg#flow, 6 of 6 labels sit inside boxes, such as “Read file” \(svg#flow > text:nth-of-type\(1\)\)/);
});

test('#997 a flowchart whose boxes have an accent strip is still text in boxes', () => {
  expect(heldFor('accent', 'text-in-boxes')[0], says('accent')).toMatch(/^In svg#accent, 5 of 5 labels sit inside boxes/);
});

test('#997 a Mermaid flowchart of named boxes is text in boxes', () => {
  expect(heldFor('mermaid', 'text-in-boxes')[0], says('mermaid')).toMatch(/^In svg#flow-m, 5 of 5 labels sit inside boxes, such as “Read file”/);
});

test('#997 a flowchart whose boxes come in two widths is text in boxes, not bars', () => {
  expect(heldFor('twosizes', 'text-in-boxes')[0], says('twosizes')).toMatch(/^In svg#twosizes, 6 of 6 labels sit inside boxes/);
});

test('#997 a box holding a sentence is held back, naming the box and its words', () => {
  expect(heldFor('flow', 'words-in-box'), says('flow')).toEqual([expect.stringMatching(/^svg#flow > rect\.note holds 12 words, “Every row is checked/)]);
});

test('#997 a bar chart with names beside its bars, values in them and a legend of swatches passes', () => {
  expect(check('chart').status, says('chart')).toBe('passed');
});

test('#997 text under 12 px at 1000 × 680 is held back, naming the smallest first; at 375 px it’s a warning', () => {
  expect
    .soft(heldFor('small', 'text-too-small'), says('small'))
    .toEqual([
      expect.stringMatching(
        /^At 1000 px, 2 of \d+ labels are under 12 px, such as “Meetings” \([^)]*svg > text\.tick\) at 9 px, “Source: the team’s timesheets” \([^)]*p\.fine\) at 10 px/,
      ),
    ]);
  expect.soft(heldFor('small', 'text-too-small-375'), says('small')).toHaveLength(1);
});

test('#997 a pale SVG label on a pale box is low contrast, measured against the box', () => {
  expect(heldFor('pale', 'contrast'), says('pale')).toEqual([expect.stringMatching(/^Text “Waiting on review” \(text#pale-label\) has contrast 1\.\d+:1/)]);
});

test('#997 a label past its SVG’s edge is cut off, naming the label and the SVG', () => {
  expect(heldFor('cut', 'text-cut-off')[0], says('cut')).toMatch(/“Peak in March” \([^)]*text\.end\) is cut off by [^.]*svg\./);
});

test('#997 labels drawn over each other are held back, naming both', () => {
  expect(heldFor('overlap', 'text-overlap')[0], says('overlap')).toMatch(/“Median income” \([^)]*text\.a\) is drawn over “Mean income” \([^)]*text\.b\)/);
});

test('#997 a figure below the first view at 1000 × 680 is held back, naming it', () => {
  expect(heldFor('below', 'first-view'), says('below')).toEqual([
    expect.stringMatching(/^At 1000 × 680 px, before any scrolling, 0% of the figure \(svg#pace, 600 × 300 px/),
  ]);
});

test('#997 a title and a figure on screen at once, with labels at 12 px or more beside their marks, pass', () => {
  expect(check('good').status, says('good')).toBe('passed');
});

test('#997 a contrast or text-size measure that throws says so as a check-error, rather than leaving the frame unanswered', async ({ page }) => {
  const kit = (name) => readFile(new URL(`../../app/kit/${name}`, import.meta.url), 'utf8');
  await page.setContent('<svg width="200" height="40"><text x="4" y="20" font-size="14">Peak demand</text></svg><p>Plain text</p>');
  await page.evaluate(() => {
    // The kit hands the check its color reader; here it throws, as a bug in it would.
    /** @type {any} */ (window).__pbCheck = {
      rgb: () => {
        throw new Error('no colors');
      },
      lum: () => 0,
    };
    SVGGraphicsElement.prototype.getScreenCTM = () => {
      throw new Error('no matrix');
    };
  });
  for (const name of ['check-layout.js', 'check-text.js']) await page.addScriptTag({ content: await kit(name) });
  const found = await page.evaluate(async () => {
    const c = /** @type {any} */ (window).__pbCheck;
    return [...(await c.lowContrast(1000)), ...(await c.smallText(1000))];
  });
  expect(found).toEqual([
    { code: 'check-error', message: expect.stringMatching(/^At 1000 px, Postbox couldn’t check for contrast: no (colors|matrix)$/) },
    { code: 'check-error', message: 'At 1000 px, Postbox couldn’t check for text-too-small: no matrix' },
  ]);
});
