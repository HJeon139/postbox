// The pre-display check sends each hidden frame what a live frame gets in its first second: a resize, and a theme change
// (#819). An app whose resize or theme handler draws before its own async setup has finished, such as
// `await postbox.load('d3')`, throws there, and the check reports a script-error with its message and line. The same app
// guarded until its library has loaded passes, and so do ordinary apps. Every app goes up in one conversation, which a
// page opened before the tests checks; each test reads what the check found.

import { expect, test } from '@playwright/test';
import { failOnServerErrors, startPostbox, synced } from './postbox.mjs';

// The library “loads” 1.5 s after the app is ready, longer than the check’s events take to arrive.
const setup = `(async () => {
  await postbox.ready;
  await new Promise((r) => setTimeout(r, 1500));
  d3 = await postbox.load('d3');
  draw();
})();`;
const draw = (guarded) => `function draw() { ${guarded ? 'if (!d3) return; ' : ''}d3.select('#c').text('drawn'); }`;

const APPS = {
  // The issue’s own example: it draws on a resize and on a theme change, assuming d3 has loaded.
  example: `<div id="c"></div>
<script>
let d3 = null;
${draw(false)}
addEventListener('resize', () => setTimeout(draw, 50));
postbox.on('theme', draw);
${setup}
</script>`,
  // The same, with draw() guarded until d3 has loaded.
  guarded: `<div id="c"></div>
<script>
let d3 = null;
${draw(true)}
addEventListener('resize', () => setTimeout(draw, 50));
postbox.on('theme', draw);
${setup}
</script>`,
  // Only a resize draws early.
  resize: `<div id="c"></div>
<script>
let d3 = null;
${draw(false)}
addEventListener('resize', draw);
${setup}
</script>`,
  // Only a theme change draws early.
  theme: `<div id="c"></div>
<script>
let d3 = null;
${draw(false)}
postbox.on('theme', draw);
${setup}
</script>`,
  // Ordinary apps: text and controls, a chart that redraws when its box resizes, and the kit’s heatmap, which redraws
  // on a theme change.
  plain: `<main style="padding:12px;color:var(--text)"><h2 style="margin:0">Corpus summary</h2><p>Twelve books, 4,210 passages.</p>
<button class="btn" type="button">Index it</button></main>`,
  observed: `<div id="c" style="padding:8px"></div>
<script>
const box = document.getElementById('c');
postbox.load('d3').then((d3) => {
  const paint = () => d3.select(box).selectAll('p').data([Math.round(box.clientWidth)]).join('p').style('color', 'var(--text)').text((w) => \`\${w} px wide\`);
  new ResizeObserver(paint).observe(box);
  postbox.on('theme', paint);
});
</script>`,
  // Review of #1099: an app that sizes itself once, at load, to the width it sees, and has no resize handler. It must
  // see the frame’s real width at load, so it fits.
  sized: `<div id="c" style="height:24px;background:var(--panel)">fits</div>
<script>document.getElementById('c').style.width = innerWidth + 'px';</script>`,
  // An error at load that happens only at a phone’s width must still be caught at 375 px.
  narrow: `<p style="color:var(--text)">Narrow only</p>
<script>if (innerWidth < 380) boomAtNarrow();</script>`,
  heatmap: `<div id="h" style="padding:8px"></div><script>postbox.charts.heatmap(document.getElementById('h'), { rows: ['Middlemarch', 'Persuasion'], cols: ['Grief', 'Hope', 'Money'], values: [[3, 5, 8], [6, 2, 4]], label: 'Themes by book' });</script>`,
};
// What each browser calls reading .select of a null d3: Firefox names d3, Chromium names the property.
const D3_NULL = /script-error: TypeError: (?:.*d3 is null|Cannot read properties of null \(reading 'select'\)) \(line \d+, column \d+\)/;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What the page threw or logged as errors while it checked the apps, apart from the d3 errors the tests cause. */
const errors = [];
// Its pages log errors on purpose; its Postbox mustn’t.
failOnServerErrors(test);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000);
  app = await startPostbox('app-check-events');
  const { rt } = app;
  // The agent hears a failed check and doesn’t answer, so each app keeps what its first check found.
  rt.adapters.register({ name: 'mock', async deliver() {} });
  const t = rt.createThread({
    projectId: Object.values(rt.s.projects)[0].id,
    title: 'App check events',
    personaIds: [rt.createPersona({ handle: 'drawer' }).id],
  });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  for (const [id, code] of Object.entries(APPS)) tools.show_app({ id, title: id, code });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => {
    if (!/d3 is null|reading 'select'|boomAtNarrow/.test(e.message)) errors.push(`exception: ${e.message}`);
  });
  page.on('console', (m) => m.type() === 'error' && errors.push(`console.error: ${m.text()}`));
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect
    .poll(() => Object.keys(APPS).filter((id) => rt.s.apps[id].check.status === 'pending'), { message: 'every app checked', timeout: 75_000 })
    .toEqual([]);
  await page.close();
});
test.afterAll(async () => {
  await app?.stop();
});

const found = (id) => app.rt.s.apps[id].check.problems ?? [];
const says = (id) =>
  found(id)
    .map((p) => `${p.code}: ${p.message}`)
    .join('\n') || 'no problems';
const passed = (id) => app.rt.s.apps[id].check.status === 'passed';

test('the page threw no exceptions and logged no errors, apart from the errors the apps throw, while it checked the apps', () => {
  expect(errors).toEqual([]);
});

test('#819 the issue’s example fails the check with a script-error naming d3 is null and its line', () => {
  expect.soft(passed('example'), says('example')).toBe(false);
  expect.soft(says('example')).toMatch(D3_NULL);
});

test('#819 an app that draws on a resize before its library loads fails the check', () => {
  expect(says('resize')).toMatch(D3_NULL);
});

test('#819 an app that draws on a theme change before its library loads fails the check, naming the line', () => {
  expect(says('theme')).toMatch(D3_NULL);
});

test('#819 the example, with draw() guarded until d3 has loaded, passes', () => {
  expect(passed('guarded'), says('guarded')).toBe(true);
});

for (const [id, what] of [
  ['plain', 'ordinary text and a button'],
  ['observed', 'a chart that redraws when its box resizes or the theme changes'],
  ['heatmap', 'the kit’s heatmap, which redraws on a theme change,'],
])
  test(`#819 ${what} still passes`, () => {
    expect(passed(id), says(id)).toBe(true);
  });

test('#819 an app that sizes itself to its width once, at load, still passes, so each frame loads at its own width', () => {
  expect(passed('sized'), says('sized')).toBe(true);
});

test('#819 an error at load that happens only at a phone’s width is still caught', () => {
  expect.soft(passed('narrow'), says('narrow')).toBe(false);
  expect.soft(says('narrow')).toMatch(/script-error: ReferenceError: boomAtNarrow/);
});
