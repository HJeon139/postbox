// Checks the pre-display check in headless Chrome, on apps made to fail it and apps that must pass it:
// - #194: text that spills out of its box (text-overflow) and text drawn over text (text-overlap), on the gallery
//   whose descriptions ran into its demo heading, and its fix. Labels a transition moves into place, and labels
//   hidden with opacity 0, and text under an opaque sticky footer, aren’t reported.
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
  check(rt.s.apps.gallery2.check.status === 'passed', 'its v2 passes', says('gallery2'));
  check(!codes('moving').includes('text-overlap'), 'labels a transition moves apart aren’t reported', says('moving'));
  check(!codes('faded').includes('text-overlap'), 'text hidden with opacity 0 isn’t reported', says('faded'));
  check(rt.s.apps.plain.check.status === 'passed', 'ordinary text set tight passes', says('plain'));
  check(rt.s.apps.sticky.check.status === 'passed', 'a list scrolled under an opaque sticky footer passes', says('sticky'));

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
