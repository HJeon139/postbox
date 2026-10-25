// Selected and on states are amber outlines (#181), in the dark theme, at 375 and 1280 px: a selected segment, a
// chosen chip and a toggle that’s on are an amber outline, never a solid fill bigger than a glyph: in Postbox, in
// Settings, and in an app’s kit (intent.md, Visual language). look.spec.mjs checks the rest of how controls look.
// Moved from tools/checks/look.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** The conversation with @librarian’s toggle, chips and app. */
let t;

test.beforeAll(async () => {
  app = await startPostbox('look-amber');
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  t = rt.createThread({ projectId: project.id, title: 'Look checks', personaIds: [rt.personaByHandle('librarian').id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  // #181: a toggle that’s on, chips to choose, and an app with a selected segment of the kit.
  tools.show_block({
    block: {
      id: 'prefs',
      type: 'form',
      version: 1,
      title: 'Index settings',
      fallback: 'Index settings',
      fields: [{ id: 'stem', label: 'Stem words', kind: 'toggle', default: true }],
    },
  });
  tools.show_block({
    block: {
      id: 'mode',
      type: 'choice',
      version: 1,
      title: 'Search mode',
      fallback: 'Search mode',
      options: ['Lexical', 'Semantic', 'Both'].map((l) => ({ id: l.toLowerCase(), label: l })),
    },
  });
  tools.show_app({
    id: 'kitseg',
    title: 'Corpus explorer',
    code: '<main style="padding:12px"><span class="seg" role="radiogroup" aria-label="Mode"><button role="radio" aria-checked="false">Lexical</button><button role="radio" aria-checked="true">Both</button></span></main>',
    permissions: [],
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'dark' });

/**
 * In the page or an app’s frame: every element of a control (a button, a radio, a switch, a checkbox) bigger than a
 * glyph whose background is amber; and, for each selected or on control, the colors that mark it.
 */
const amberIn = (sel) => {
  const root = /** @type {Element} */ (document.querySelector(sel));
  const probe = (v) => {
    const p = document.createElement('span');
    p.style.background = v;
    document.body.append(p);
    const c = getComputedStyle(p).backgroundColor;
    p.remove();
    return c;
  };
  const accent = probe('var(--accent)');
  const amber = new Set([accent, probe('var(--on)')]);
  const solid = [];
  for (const c of root.querySelectorAll('button, [role=radio], [role=switch], [role=checkbox], [aria-pressed], [aria-checked]'))
    for (const n of [c, ...c.querySelectorAll('*')]) {
      const r = n.getBoundingClientRect();
      if (Math.min(r.width, r.height) > 18 && amber.has(getComputedStyle(n).backgroundColor))
        solid.push(
          `${n.tagName.toLowerCase()}.${[...n.classList].join('.')} “${c.textContent?.trim().slice(0, 30)}” ${Math.round(r.width)}×${Math.round(r.height)}`,
        );
    }
  const on = [
    ...root.querySelectorAll('.seg button[aria-checked=true], .chip[aria-checked=true], .chip[aria-pressed=true], .toggle[aria-checked=true] .track'),
  ].map((n) => {
    const s = getComputedStyle(n);
    return {
      what: n.closest('.seg, .chip, .toggle')?.classList[0],
      text: s.color,
      edge: s.borderTopColor === accent || s.boxShadow.includes(accent),
      knob: getComputedStyle(n, '::after').backgroundColor,
    };
  });
  return { solid, on, accent };
};
/** What’s wrong with how a place marks its selected and on states: an amber fill, or a state not marked in amber. */
function unmarked(found, where, kinds) {
  const bad = found.solid.map((s) => `${where}: a solid amber fill on ${s}`);
  for (const k of kinds) if (!found.on.some((o) => o.what === k)) bad.push(`${where}: no selected ${k} to look at`);
  for (const o of found.on) {
    if (!o.edge) bad.push(`${where}: a selected ${o.what} has no amber edge`);
    if ((o.what === 'toggle' ? o.knob : o.text) !== found.accent) bad.push(`${where}: a selected ${o.what} isn’t marked in amber (${o.text}, knob ${o.knob})`);
  }
  return bad;
}

for (const width of [1280, 375])
  test.describe(`${width} px`, () => {
    test.use(width < 768 ? { viewport: { width, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height: 900 } });
    test(`#181 at ${width} px (dark): selected segments, chosen chips and on toggles are amber outlines, in Postbox, Settings and an app`, async ({ page }) => {
      await page.goto(`${app.origin}/#/t/${t.id}`);
      await synced(page, app);
      await expect(page.locator('.toggle[aria-checked=true]')).toBeVisible();
      await page.locator('.chips .chip').last().click();
      await expect(page.locator('.chips .chip').last()).toHaveAttribute('aria-checked', 'true');
      await settled(page);
      const bad = unmarked(await page.evaluate(amberIn, 'body'), 'the conversation', ['toggle', 'chip']);
      // The app runs in a frame of its own, in its own process.
      const handle = await page.locator('.appframe iframe.app-iframe').elementHandle();
      const frame = await handle?.contentFrame();
      if (!frame) throw new Error('The app’s frame has no document to read');
      await expect(frame.locator('.seg')).toBeVisible();
      bad.push(...unmarked(await frame.evaluate(amberIn, 'body'), 'the app', ['seg']));
      await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.locator('.dialog .seg button[aria-checked=true]').first()).toBeVisible();
      bad.push(...unmarked(await page.evaluate(amberIn, '.dialog'), 'Settings', ['seg']));
      expect(bad).toEqual([]);
    });
  });
