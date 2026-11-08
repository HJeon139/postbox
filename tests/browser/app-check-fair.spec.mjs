// What the readability checks of #997 must not hold back, from the review of #1008: apps a person can read. Every app
// goes up in one conversation, which a page opened before the tests checks; each test reads what the check found.
// - Contrast: a label the check can’t measure the background of is left unjudged (a gradient, a shape drawn by <use>,
//   a label in a box that scrolls sideways), and one on a solid shape or a thick route line is measured against it.
//   One that is too faint on its shape is told to change its ink for that fill, never to use the page’s text color.
// - The kit’s own styles meet the 12 px floor in an app: kbd and every class the guide offers.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

failOnPageErrors(test);

// White labels on a dark navy shape, drawn several ways; navy and white are about 14:1.
const ON = 'fill="#ffffff" font-size="14"';
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
