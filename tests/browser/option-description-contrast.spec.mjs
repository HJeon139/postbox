// #873: a chosen option’s description must read on the chosen chip itself. The light theme fills a chosen chip with
// --on, and its description kept --dim, a mid brown, so it sat dark on dark. The dark theme draws a chosen chip as an
// outline, so its description stays on the chip’s own background. Checked by computed colors, in both themes and at
// both widths, since the contrast lint sees token pairs, not which element sits on which.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let t;

test.beforeAll(async () => {
  app = await startPostbox('option-description-contrast');
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  t = rt.createThread({ projectId: project.id, title: 'Index plan', personaIds: [rt.personaByHandle('librarian').id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  const options = [
    { id: 'keep', label: 'Keep it', description: 'Leaves the index as it is.' },
    { id: 'rebuild', label: 'Rebuild', description: 'Takes about ten minutes.' },
  ];
  tools.show_block({ block: { id: 'which', type: 'choice', version: 1, title: 'The index', fallback: 'Keep or rebuild?', options } });
  // A multiple choice marks a chosen chip with aria-pressed, where a single one uses aria-checked.
  tools.show_block({ block: { id: 'steps', type: 'choice', version: 1, title: 'The steps', fallback: 'Which steps?', multiple: true, options } });
  // One per test run: once answered it stays answered, so each theme and width answers its own.
  // Their own words, so a locator by another block's title never matches them.
  const kept = [
    { id: 'keep', label: 'Keep it', description: 'Changes nothing today.' },
    { id: 'rebuild', label: 'Rebuild', description: 'Takes about ten minutes.' },
  ];
  for (const scheme of ['light', 'dark'])
    for (const w of [375, 1280])
      tools.show_block({
        block: { id: `answered-${scheme}-${w}`, type: 'choice', version: 1, title: `Answered ${scheme} ${w}`, fallback: 'Keep or rebuild?', options: kept },
      });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/**
 * The WCAG contrast of an element’s text as it shows: on the nearest ancestor (or itself) with an opaque background,
 * and, where that layer or anything inside it is see-through (`opacity`, as on an answered choice’s chips), blended over
 * what’s behind it.
 */
async function contrastOn(locator) {
  return locator.evaluate((el) => {
    const rgb = (s) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]) => {
      const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const opaqueFrom = (start) => {
      let at = start;
      let bg = rgb(getComputedStyle(at).backgroundColor);
      while (at && (bg.length < 3 || bg[3] === 0)) {
        at = at.parentElement;
        bg = at ? rgb(getComputedStyle(at).backgroundColor) : [0, 0, 0];
      }
      return { at, bg };
    };
    const fg = rgb(getComputedStyle(el).color);
    const layer = opaqueFrom(el);
    // How see-through the layer is, from the text up to and including the layer that paints the background.
    let alpha = 1;
    for (let n = el; n; n = n.parentElement) {
      alpha *= Number(getComputedStyle(n).opacity);
      if (n === layer.at) break;
    }
    const behind = layer.at?.parentElement ? opaqueFrom(layer.at.parentElement).bg : [255, 255, 255];
    const mix = (c) => c.slice(0, 3).map((v, i) => alpha * v + (1 - alpha) * behind[i]);
    const [hi, lo] = [lum(mix(fg)), lum(mix(layer.bg))].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });
}

for (const colorScheme of /** @type {const} */ (['light', 'dark']))
  for (const width of [375, 1280])
    test.describe(`${colorScheme}, ${width} px`, () => {
      test.use({ colorScheme, viewport: { width, height: 900 } });

      test(`#873 a chosen option’s description reads on its chip (${colorScheme}, ${width} px)`, async ({ page }) => {
        await page.goto(`${app.origin}/#/t/${t.id}`);
        await synced(page, app);
        await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
        const choice = page.locator('.transcript .block', { hasText: 'The index' });
        const keep = choice.getByRole('radio', { name: /Keep it/ });
        const rebuild = choice.getByRole('radio', { name: /Rebuild/ });
        await keep.click();
        await expect(keep).toHaveAttribute('aria-checked', 'true');
        const chosen = await contrastOn(keep.locator('.chip-desc'));
        const other = await contrastOn(rebuild.locator('.chip-desc'));
        expect(chosen, `the chosen option’s description: ${chosen.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        expect(other, `an unchosen option’s description: ${other.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        const many = page.locator('.transcript .block', { hasText: 'The steps' });
        const step = many.getByRole('button', { name: /Rebuild/ });
        await step.click();
        await expect(step).toHaveAttribute('aria-pressed', 'true');
        const pressed = await contrastOn(step.locator('.chip-desc'));
        expect(pressed, `a chosen option’s description in a multiple choice: ${pressed.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });

      test(`#873 once a choice is answered, its chosen option still reads: its label and its description (${colorScheme}, ${width} px)`, async ({ page }) => {
        await page.goto(`${app.origin}/#/t/${t.id}`);
        await synced(page, app);
        const choice = page.locator('.transcript .block', { hasText: `Answered ${colorScheme} ${width}` });
        const keep = choice.getByRole('radio', { name: /Keep it/ });
        await keep.click();
        await choice.getByRole('button', { name: 'Send choice' }).click();
        await expect(keep).toBeDisabled();
        const label = await contrastOn(keep.locator('.chip-text > span').first());
        const desc = await contrastOn(keep.locator('.chip-desc'));
        expect(label, `the answered choice’s chosen label: ${label.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        expect(desc, `the answered choice’s chosen description: ${desc.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
    });
