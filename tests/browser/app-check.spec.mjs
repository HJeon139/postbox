// The pre-display check, on apps made to fail it and apps that must pass it:
// - #194: text that spills out of its box (text-overflow) and text drawn over text (text-overlap), on the gallery whose
//   descriptions ran into its demo heading, and its fix. Labels a transition moves into place, labels hidden with
//   opacity 0, and text under an opaque sticky footer aren’t reported.
// - #89: controls you can’t see or click (control-hidden): a row of buttons clipped by Postbox’s own .bar class, and a
//   button under an overlay. Controls in a scroll box, and a checkbox hidden for screen readers, aren’t reported.
// Every app goes up in one conversation, which a page opened before the tests checks; each test reads what the check
// found for its apps. Moved from tools/checks/app-check.mjs (#303).

import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { startPostbox, synced } from './postbox.mjs';

// The “Eight visual forms” gallery (#194), cut down: v1 sets its buttons nowrap in a fixed 230 px column, so their
// text runs into the demo heading beside it; v2 lets them wrap, in a column that can shrink.
const FORMS = [
  ['Flow', 'Several routes through shared, ordered steps'],
  ['Shape', 'A system with feedback loops'],
  ['Change', 'One quantity rising and falling over a year'],
];
const gallery = (fixed) => `<style>
.gx{display:grid;grid-template-columns:${fixed ? 'minmax(0,230px)' : '230px'} 1fr;gap:16px;padding:12px}
.gx nav{display:flex;flex-direction:column;gap:6px}
.gx-item{white-space:${fixed ? 'normal' : 'nowrap'};text-align:left;background:none;border:1px solid var(--line);border-radius:6px;color:var(--text);padding:6px 8px;font:14px system-ui,sans-serif}
.gx h3{margin:0 0 8px;color:var(--text)}.gx p{margin:0;color:var(--text)}
@media (max-width:600px){.gx{grid-template-columns:1fr}}
</style>
<div class="gx"><nav aria-label="Forms">${FORMS.map(([k, d]) => `<button class="gx-item" type="button">${k}: ${d}</button>`).join('')}</nav>
<section><h3>Shape: A system with feedback loops</h3><p>Pick a form to see it drawn.</p></section></div>`;

const APPS = {
  // The issue’s own acceptance case.
  grid: `<div style="display:grid;grid-template-columns:120px 1fr;color:var(--text);padding:8px"><p style="white-space:nowrap;margin:0">a long description that won’t fit</p><h3 style="margin:0">Heading</h3></div>`,
  gallery1: gallery(false),
  gallery2: gallery(true),
  // Labels that start stacked and move apart a moment later, as a d3 transition places them. They move right after
  // the check’s first look, its first measure of text (Range’s getClientRects), so its second look always sees them
  // apart. A wall-clock delay raced the check on a loaded runner (#398).
  moving: `<svg width="320" height="80" role="img" aria-label="Three labels"><g id="ls">${['Alpha', 'Beta', 'Gamma']
    .map((t) => `<text x="20" y="40" fill="var(--text)" font-size="14">${t}</text>`)
    .join('')}</g></svg>
<script>{
  const rects = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function () {
    Range.prototype.getClientRects = rects;
    setTimeout(() => document.querySelectorAll('#ls text').forEach((l, i) => l.setAttribute('x', 20 + i * 100)));
    return rects.call(this);
  };
}</script>`,
  // A tooltip hidden with opacity 0 over the text it explains.
  faded: `<div style="position:relative;padding:12px;color:var(--text)"><p style="margin:0">Hover a bar to see its value.</p><span style="position:absolute;left:12px;top:12px;opacity:0">Value: 42 claims</span></div>`,
  // A long list that runs under its opaque sticky footer, as the corpus explorer’s does: hidden there, not overlapped.
  sticky: `<ul style="margin:0;padding:12px;color:var(--text)">${Array.from({ length: 80 }, (_, i) => `<li>Passage ${i + 1}, about hope after loss</li>`).join('')}</ul>
<div style="position:sticky;bottom:0;background:var(--sunk);color:var(--text);padding:10px 14px">Nothing selected</div>`,
  // #327: a class from Postbox’s shell stylesheet changes the app’s own layout.
  collision: `<div class="app" style="color:var(--text)"><p class="title">App content</p><p>Should stay in one column</p></div>`,
  // #89: a row of filter buttons in class="bar", which Postbox’s stylesheet makes a 4 px progress bar.
  bar: `<p style="color:var(--text);margin:8px">Filter the frames:</p><div class="bar">${['All', 'Intro', 'Method', 'Results', 'Limits', 'Next']
    .map((t) => `<button class="btn" type="button">${t}</button>`)
    .join('')}</div>`,
  // #89: a button under an overlay positioned over it.
  covered: `<div style="position:relative;padding:12px"><button class="btn" type="button">Run it</button><div style="position:absolute;inset:0;background:var(--panel)"></div></div>`,
  // Controls a scroll box holds past its edge, which you scroll to, and a checkbox hidden for screen readers behind its label.
  scrolled: `<div style="height:120px;overflow:auto;padding:8px;color:var(--text)">${Array.from({ length: 12 }, (_, i) => `<p style="margin:0 0 8px">Row ${i + 1} <button class="btn sm" type="button">Open ${i + 1}</button></p>`).join('')}</div>
<label style="position:relative;display:inline-flex;gap:6px;padding:8px;color:var(--text)"><input type="checkbox" style="position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden">Show years</label>`,
  // Text cut short with an ellipsis, a label hidden for screen readers, a label drawn twice for its halo, and rotated
  // tick labels, beside other text: none of them is text over text.
  clipped: `<div style="display:flex;gap:8px;padding:8px;color:var(--text)"><span style="width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">A title far too long for its box</span><span>12 Oct</span></div>
<button class="btn" type="button"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Close the panel and go back</span>×</button> <span style="color:var(--text)">Panel</span>
<svg width="300" height="90" role="img" aria-label="Ticks"><text x="40" y="20" fill="var(--panel)" stroke="var(--panel)" stroke-width="4">Paris</text><text x="40" y="20" fill="var(--text)">Paris</text>${[
    0, 1, 2, 3, 4,
  ]
    .map((i) => `<text transform="translate(${40 + i * 22},80) rotate(-45)" fill="var(--text)" font-size="12">Category ${i}</text>`)
    .join('')}</svg>`,
  // A page that scrolls smoothly, with a button under an overlay far below the first screen, and one a box clips sideways.
  smooth: `<style>html{scroll-behavior:smooth}</style><div style="height:1400px"></div><div style="position:relative;padding:12px"><button class="btn" type="button">Deep</button><div style="position:absolute;inset:0;background:var(--panel)"></div></div>
<div style="width:30px;overflow-x:hidden;overflow-y:auto"><button class="btn" type="button" style="white-space:nowrap">A wide button label</button></div>`,
  // Math KaTeX sets, inline and on its own line: its glyphs sit over each other on purpose.
  katex: `<div style="padding:12px;color:var(--text)"><p>The estimate <span id="a"></span> is close.</p><div id="b"></div><div id="c"></div></div>
<script>postbox.load('katex').then((k) => {
  k.render('\\\\hat{y}', document.getElementById('a'));
  k.render('\\\\vec{v}\\\\cdot\\\\dot{x}', document.getElementById('b'), { displayMode: true });
  k.render('\\\\sum_{i=1}^{n} x_i', document.getElementById('c'), { displayMode: true });
});</script>`,
  // A big figure set tight over its caption, a <pre> in a box that scrolls sideways, and a badge past a button’s corner.
  tight: `<div style="padding:12px;color:var(--text)"><div style="font-size:40px;line-height:.9;font-weight:600">4,210</div><div style="font-size:12px">passages read</div>
<div style="overflow-x:auto;margin-top:8px"><pre style="margin:0">const passages = corpus.search({ query: 'hope after loss', mode: 'both', k: 12 });</pre></div>
<button class="btn" type="button" style="position:relative;margin-top:12px">Inbox<span style="position:absolute;top:-6px;right:-14px;background:var(--accent);color:var(--on-ink);border-radius:8px;padding:0 5px;font-size:11px">12</span></button></div>`,
  // Sixty opaque cards stacked in one place, each of 25 lines: every line is over another, and hidden under the top card.
  cards: `<div style="position:relative;height:600px">${Array.from({ length: 60 }, (_, i) => `<div style="position:absolute;inset:0;background:var(--panel);color:var(--text);padding:8px">${Array.from({ length: 25 }, (_, j) => `Card ${i + 1}, line ${j + 1}`).join('<br>')}</div>`).join('')}</div>`,
  // Controls hidden on purpose: under an open modal dialog, a carousel’s other slides, an accordion closed at max-height: 0,
  // a menu at scale(0), and custom radios whose inputs have no size.
  purpose: `<div style="padding:12px;color:var(--text)"><button class="btn" type="button">Behind the dialog</button>
<div style="overflow:hidden;width:200px"><div style="display:flex;width:600px"><button class="btn" type="button" style="width:200px">Slide 1</button><button class="btn" type="button" style="width:200px">Slide 2</button><button class="btn" type="button" style="width:200px">Slide 3</button></div></div>
<div style="max-height:0;overflow:hidden"><button class="btn" type="button">In the closed accordion</button></div>
<div style="transform:scale(0)"><button class="btn" type="button">In the closed menu</button></div>
<label><input type="radio" name="r" style="width:0;height:0;margin:0"> Weekly</label> <label><input type="radio" name="r" style="width:0;height:0;margin:0"> Daily</label>
<dialog id="d"><p>Pick a corpus first.</p><button class="btn" type="button">OK</button></dialog></div>
<script>document.getElementById('d').showModal();</script>`,
  // A watermark you can barely see over a button: it takes the button’s clicks.
  watermark: `<div style="position:relative;padding:12px"><button class="btn" type="button">Export</button><div class="wm" style="position:absolute;inset:0;opacity:.06;background:var(--text)"></div></div>`,
  // The kit’s own heatmap, 8 columns, at 375 px too.
  heatmap: `<div id="h" style="padding:8px"></div><script>postbox.charts.heatmap(document.getElementById('h'), { rows: ['Middlemarch', 'Persuasion', 'Emma'], cols: ['Grief', 'Hope', 'Money', 'The sea', 'Marriage', 'Duty', 'Faith', 'Travel'], values: [[3, 5, 8, 0, 9, 4, 2, 1], [6, 2, 4, 1, 8, 5, 3, 0], [1, 4, 6, 0, 9, 3, 2, 2]], label: 'Themes by book' });</script>`,
  // Ordinary text and controls, set tight: nothing to report.
  plain: `<main style="padding:12px;color:var(--text);line-height:1.1"><h2 style="margin:0">Corpus summary</h2><p style="margin:0">Twelve <b>books</b>, <i>4,210</i> passages, read in <code>order</code>.</p>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn" type="button">Index it</button><button class="btn" type="button">Later</button></div>
<table><tr><th>Book</th><th>Passages</th></tr><tr><td>Middlemarch</td><td>812</td></tr></table></main>`,
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What the page logged as errors while it checked the apps. */
const errors = [];
test.beforeAll(async ({ browser }) => {
  // Mermaid, KaTeX and the kit load on first use, and seventeen apps are checked at two widths.
  test.setTimeout(120_000);
  app = await startPostbox('app-check');
  const { rt } = app;
  // The agent hears a failed check and doesn’t answer, so each app keeps what its first check found.
  rt.adapters.register({ name: 'mock', async deliver() {} });
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: 'App check', personaIds: [rt.createPersona({ handle: 'drawer' }).id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  for (const [id, code] of Object.entries(APPS)) tools.show_app({ id, title: id, code });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => errors.push(`exception: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console.error: ${m.text()}`));
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

const found = (id) => app.rt.s.apps[id].check.problems ?? [];
const codes = (id) => found(id).map((p) => p.code);
const says = (id) =>
  found(id)
    .map((p) => `${p.code}: ${p.message}`)
    .join('\n') || 'no problems';
/** A negative assertion counts only for a check that finished: a frame that never answered reports nothing either. */
const finished = (id) => app.rt.s.apps[id].check.status !== 'pending' && !codes(id).some((c) => c === 'no-answer' || c === 'check-error');
const clean = (id) => finished(id) && app.rt.s.apps[id].check.status === 'passed';

test('the page threw no exceptions and logged no errors while it checked the apps', () => {
  expect(errors).toEqual([]);
});

// ── #194: text out of its box, and text over text ───────────────────────────────────────
// Where a test holds what were separate checks, its expects are soft: each reports, whichever fails first.

test('#194 nowrap text in a 120 px column overflows and overlaps, and the messages name the texts, the widths and the usual fix', () => {
  expect.soft(codes('grid'), says('grid')).toEqual(expect.arrayContaining(['text-overflow', 'text-overlap']));
  const over = found('grid').find((p) => p.code === 'text-overflow')?.message ?? '';
  expect.soft(over).toMatch(/“a long description that won’t fit” is \d+ px wide in a 120 px box/);
  expect.soft(over).toMatch(/white-space: nowrap/);
  expect.soft(over).toMatch(/minmax\(0, …\)/);
  expect.soft(found('grid').find((p) => p.code === 'text-overlap')?.message, 'text-overlap names both texts').toMatch(/drawn over “Heading”/);
});

test('#194 the gallery’s v1 fails, and its v2 passes', () => {
  expect.soft(codes('gallery1'), says('gallery1')).toEqual(expect.arrayContaining(['text-overflow', 'text-overlap']));
  expect.soft(clean('gallery2'), says('gallery2')).toBe(true);
});

for (const [id, what] of [
  ['moving', 'labels a transition moves apart'],
  ['faded', 'text hidden with opacity 0'],
  ['clipped', 'text cut by its own box, a halo and rotated labels'],
  ['cards', 'sixty opaque cards stacked in one place, with nothing over them,'],
])
  test(`#194 ${what} aren’t reported as text over text`, () => {
    expect(finished(id) && !codes(id).includes('text-overlap'), says(id)).toBe(true);
  });

for (const [id, what] of [
  ['plain', 'ordinary text set tight'],
  ['sticky', 'a list scrolled under an opaque sticky footer'],
  ['katex', 'KaTeX math, inline and on its own line,'],
  ['tight', 'a figure set tight over its caption, a <pre> that scrolls sideways and a badge past a corner'],
  ['heatmap', 'the kit’s own heatmap with 8 columns, at both widths,'],
])
  test(`#194 ${what} passes`, () => {
    expect(clean(id), says(id)).toBe(true);
  });

test('#194 an overlap there both times the check looks is reported, and one that moved away isn’t', async ({ page }) => {
  const layout = await readFile(new URL('../../app/kit/check-layout.js', import.meta.url), 'utf8');
  await page.setContent(
    '<p style="position:absolute;left:0;top:0;margin:0">Still label</p><p style="position:absolute;left:4px;top:2px;margin:0">Stays here</p><p id="m" style="position:absolute;left:0;top:60px;margin:0">Moving label</p><p style="position:absolute;left:4px;top:62px;margin:0">Moved from</p>',
  );
  await page.evaluate(() => {
    /** @type {any} */ (window).__pbCheck = {};
  });
  await page.addScriptTag({ content: layout });
  const twice = await page.evaluate(() => {
    // The moving label goes 400 ms in, between the check’s two looks.
    const t0 = performance.now();
    const move = () =>
      performance.now() - t0 >= 400 ? /** @type {HTMLElement} */ ((document.getElementById('m').style.left = '300px')) : requestAnimationFrame(move);
    requestAnimationFrame(move);
    return /** @type {any} */ (window).__pbCheck.textOverlap(1280);
  });
  expect(twice.length, JSON.stringify(twice)).toBe(1);
  expect(twice[0].message).toMatch(/“Still label” is drawn over “Stays here”/);
});

// ── #327 and #89: Postbox styles and controls you can’t see or click ─────────────────────

test('#327 an app class that Postbox’s shell also defines is reported with the prefix fix', () => {
  expect(says('collision')).toContain(
    'class-collision: The class .app is also defined by Postbox’s stylesheet, so its shell styles change this app. Give the app’s class a prefix of its own, such as app-app.',
  );
  expect(says('collision')).toContain('class-collision: The class .title is also defined by Postbox’s stylesheet');
});

test('#89 the .bar row is control-hidden once at each width, and says why: div.bar, a class of Postbox’s own stylesheet', () => {
  const bar = found('bar').filter((p) => p.code === 'control-hidden');
  expect(bar.length, says('bar')).toBe(2);
  for (const p of bar) {
    expect(p.message).toMatch(/6 controls, such as the button “All”, are clipped to \d+ × 4 px by div\.bar/);
    expect(p.message).toMatch(/\.bar is a class of Postbox’s own stylesheet/);
  }
});

test('#89 a button under an overlay is control-hidden, far down a smooth-scrolling page too, and one a box clips sideways', () => {
  expect.soft(says('covered')).toMatch(/the button “Run it” is under div, which takes its clicks/);
  expect.soft(says('smooth')).toMatch(/the button “Deep” is under div/);
  expect.soft(says('smooth')).toMatch(/the button “A wide button label” is clipped/);
});

test('#89 a faint watermark over a button says to give it pointer-events: none', () => {
  expect(says('watermark')).toMatch(
    /the button “Export” is under div\.wm, which is nearly transparent but takes its clicks\. Give div\.wm pointer-events: none\./,
  );
});

for (const [id, what] of [
  ['purpose', 'controls under an open modal, on other slides, in a closed accordion or menu, and hidden radios'],
  ['scrolled', 'controls in a scroll box, and a checkbox hidden for screen readers,'],
])
  test(`#89 ${what} pass`, () => {
    expect(clean(id), says(id)).toBe(true);
  });
