// Checks the pre-display check in headless Chrome, on apps made to fail it and apps that must pass it:
// - #194: text that spills out of its box (text-overflow) and text drawn over text (text-overlap), on the gallery
//   whose descriptions ran into its demo heading, and its fix. Labels a transition moves into place, and labels
//   hidden with opacity 0, and text under an opaque sticky footer, aren’t reported.
// - #89: controls you can’t see or click (control-hidden): a row of buttons clipped by Postbox’s own .bar class, and a
//   button under an overlay. Controls in a scroll box, and a checkbox hidden for screen readers, aren’t reported.
//
//   node tools/checks/app-check.mjs
//
// PB_PORT and PB_CHROME_PORT move it (4910 and 10210 by default), so sessions working in parallel don’t collide.
// It reports through tools/harness.mjs: one line per assertion, and exit code 1 on any failure.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch, sleep } from '../cdp.mjs';
import { record as check, finish, ports } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(4910, 10210);

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
  // Labels that start stacked and move apart a moment later, as a d3 transition places them.
  moving: `<svg width="320" height="80" role="img" aria-label="Three labels"><g id="ls">${['Alpha', 'Beta', 'Gamma']
    .map((t) => `<text x="20" y="40" fill="var(--text)" font-size="14">${t}</text>`)
    .join('')}</g></svg>
<script>postbox.ready.then(() => setTimeout(() => {
  const ls = [...document.querySelectorAll('#ls text')], t0 = performance.now();
  const step = (now) => { const k = Math.min(1, (now - t0) / 300); ls.forEach((l, i) => l.setAttribute('x', 20 + i * 100 * k)); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}, 1900));</script>`,
  // A tooltip hidden with opacity 0 over the text it explains.
  faded: `<div style="position:relative;padding:12px;color:var(--text)"><p style="margin:0">Hover a bar to see its value.</p><span style="position:absolute;left:12px;top:12px;opacity:0">Value: 42 claims</span></div>`,
  // A long list that runs under its opaque sticky footer, as the corpus explorer’s does: hidden there, not overlapped.
  sticky: `<ul style="margin:0;padding:12px;color:var(--text)">${Array.from({ length: 80 }, (_, i) => `<li>Passage ${i + 1}, about hope after loss</li>`).join('')}</ul>
<div style="position:sticky;bottom:0;background:var(--sunk);color:var(--text);padding:10px 14px">Nothing selected</div>`,
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

const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-app-check-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
// The agent hears a failed check and doesn’t answer, so each app keeps what its first check found.
app.rt.adapters.register({ name: 'mock', async deliver() {} });
let page = null;

try {
  const { rt, store } = app;
  const projectId = Object.values(rt.s.projects)[0].id;
  const persona = rt.createPersona({ handle: 'drawer' });
  const t = rt.createThread({ projectId, title: 'App check', personaIds: [persona.id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  for (const [id, code] of Object.entries(APPS)) tools.show_app({ id, title: id, code });

  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900, { theme: 'dark' });
  await page.goto(app.origin);
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = '#/t/${t.id}'`);
  const end = Date.now() + 40000;
  while (Date.now() < end && Object.keys(APPS).some((id) => rt.s.apps[id].check.status === 'pending')) await sleep(200);
  const found = (id) => rt.s.apps[id].check.problems ?? [];
  const codes = (id) => found(id).map((p) => p.code);
  const says = (id) =>
    found(id)
      .map((p) => `${p.code}: ${p.message}`)
      .join('\n') || 'no problems';
  // A negative assertion counts only for a check that finished: a frame that never answered reports nothing either.
  const finished = (id) => rt.s.apps[id].check.status !== 'pending' && !codes(id).some((c) => c === 'no-answer' || c === 'check-error');
  const clean = (id) => finished(id) && rt.s.apps[id].check.status === 'passed';

  check(
    codes('grid').includes('text-overflow') && codes('grid').includes('text-overlap'),
    '#194: nowrap text in a 120 px column overflows and overlaps',
    says('grid'),
  );
  const over = found('grid').find((p) => p.code === 'text-overflow')?.message ?? '';
  check(/“a long description that won’t fit” is \d+ px wide in a 120 px box/.test(over), 'the message names the text and both widths', over);
  check(/white-space: nowrap/.test(over) && /minmax\(0, …\)/.test(over), 'and the usual fix', over);
  check(/drawn over “Heading”/.test(found('grid').find((p) => p.code === 'text-overlap')?.message ?? ''), 'text-overlap names both texts', says('grid'));
  check(codes('gallery1').includes('text-overflow') && codes('gallery1').includes('text-overlap'), 'the gallery’s v1 fails', says('gallery1'));
  check(clean('gallery2'), 'its v2 passes', says('gallery2'));
  check(finished('moving') && !codes('moving').includes('text-overlap'), 'labels a transition moves apart aren’t reported', says('moving'));
  check(finished('faded') && !codes('faded').includes('text-overlap'), 'text hidden with opacity 0 isn’t reported', says('faded'));
  check(clean('plain'), 'ordinary text set tight passes', says('plain'));
  check(clean('sticky'), 'a list scrolled under an opaque sticky footer passes', says('sticky'));

  const bar = found('bar').filter((p) => p.code === 'control-hidden');
  check(bar.length === 2, '#89: the .bar row is control-hidden, once at each width', says('bar'));
  check(
    bar.every(
      (p) =>
        /6 controls, such as the button “All”, are clipped to \d+ × 4 px by div\.bar/.test(p.message) &&
        /\.bar is a class of Postbox’s own stylesheet/.test(p.message),
    ),
    'the message counts the buttons, names div.bar and says .bar is Postbox’s',
    says('bar'),
  );
  check(/the button “Run it” is under div, which takes its clicks/.test(says('covered')), '#89: a button under an overlay is control-hidden', says('covered'));
  check(
    finished('clipped') && !codes('clipped').includes('text-overlap'),
    'text cut by its own box, a halo and rotated labels aren’t text over text',
    says('clipped'),
  );
  check(/the button “Deep” is under div/.test(says('smooth')), 'a covered control far down a smooth-scrolling page is found', says('smooth'));
  check(/the button “A wide button label” is clipped/.test(says('smooth')), 'and one a box clips sideways while it scrolls up and down', says('smooth'));
  check(clean('katex'), 'KaTeX math, inline and on its own line, passes', says('katex'));
  check(clean('tight'), 'a figure set tight over its caption, a <pre> that scrolls sideways and a badge past a corner pass', says('tight'));
  check(finished('cards') && !codes('cards').includes('text-overlap'), 'sixty opaque cards stacked in one place finish, with nothing over them', says('cards'));
  check(clean('purpose'), 'controls under an open modal, on other slides, in a closed accordion or menu, and hidden radios pass', says('purpose'));
  check(
    /the button “Export” is under div\.wm, which is nearly transparent but takes its clicks\. Give div\.wm pointer-events: none\./.test(says('watermark')),
    'a faint watermark over a button says to give it pointer-events: none',
    says('watermark'),
  );
  check(clean('heatmap'), 'the kit’s own heatmap with 8 columns passes at both widths', says('heatmap'));
  check(clean('scrolled'), 'controls in a scroll box, and a checkbox hidden for screen readers, pass', says('scrolled'));

  // How text-overlap measures, on its own in a blank page: an overlap counts only when it’s there both times.
  await page.goto('about:blank');
  const layout = await readFile(new URL('../../app/kit/check-layout.js', import.meta.url), 'utf8');
  await page.evaluate(`window.__pbCheck = {}; (0, eval)(${JSON.stringify(layout)});`);
  await page.evaluate(
    `document.body.innerHTML = '<p style="position:absolute;left:0;top:0;margin:0">Still label</p><p style="position:absolute;left:4px;top:2px;margin:0">Stays here</p><p id="m" style="position:absolute;left:0;top:60px;margin:0">Moving label</p><p style="position:absolute;left:4px;top:62px;margin:0">Moved from</p>'`,
  );
  const twice = await page.evaluate(
    `(() => { const p = window.__pbCheck.textOverlap(1280); setTimeout(() => { document.getElementById('m').style.left = '300px'; }, 400); return p; })()`,
  );
  check(
    twice.length === 1 && /“Still label” is drawn over “Stays here”/.test(twice[0].message),
    'an overlap there both times is reported, and one that moved away isn’t',
    JSON.stringify(twice),
  );
} catch (e) {
  check(false, 'the check ran to the end', e.stack ?? e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
finish();
