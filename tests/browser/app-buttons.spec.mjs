// An agent app’s buttons rank its actions, and a choice among options is a segmented control, not one button beside
// link-looking text (#971). In each theme, an app with a .seg choice, a .btn.primary and a plain .btn:
// - passes its pre-display check, with .primary a kit class, not a collision with Postbox’s stylesheet;
// - draws .btn.primary filled with --on and labeled in --on-ink, at 4.5:1 or more, unlike the plain button beside it.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const APP = `<main style="padding:12px;display:flex;flex-direction:column;gap:12px;color:var(--text)">
<div class="seg" role="group" aria-label="Corpus"><button type="button" aria-pressed="true">Novels</button><button type="button" aria-pressed="false">Letters</button><button type="button" aria-pressed="false">Essays</button></div>
<div style="display:flex;gap:8px"><button id="run" class="btn primary" type="button">Run the search</button><button id="reset" class="btn" type="button">Reset</button></div>
</main>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-buttons');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** WCAG’s contrast ratio of two computed rgb() colors. */
function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

for (const theme of /** @type {const} */ (['light', 'dark']))
  test.describe(`${theme}`, () => {
    test.use({ colorScheme: theme });

    test(`#971 (${theme}) an app’s .btn.primary is filled with --on, readable, and outranks a plain .btn; .primary is a kit class`, async ({ page }) => {
      const { rt } = app;
      const title = `Buttons ${theme}`;
      const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title, personaIds: [arrange.persona(rt, 'librarian').id] });
      const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
      const id = `buttons-${t.id}`;
      await page.goto(`${app.origin}/#/t/${t.id}`);
      await synced(page, app);
      tools.show_app({ id, title, code: APP, permissions: [] });
      await expect.poll(() => rt.store.state.apps[id]?.check.status, { message: 'the app’s check to finish' }).not.toBe('pending');
      const says = () => JSON.stringify(rt.store.state.apps[id].check.problems ?? []);
      expect.soft(rt.store.state.apps[id].check.status, says()).toBe('passed');
      await expect(frameOf(page, title), 'the app to load').toHaveAttribute('data-sized', '1');

      const frame = frameOf(page, title).contentFrame();
      await expect(frame.locator('html')).toHaveAttribute('data-theme', theme);
      const look = await frame.locator('#run').evaluate((run) => {
        const root = getComputedStyle(document.documentElement);
        // Resolve the tokens to computed colors through an element of their own, so both sides compare as rgb().
        const probe = document.body.appendChild(document.createElement('i'));
        probe.style.cssText = 'background: var(--on); color: var(--on-ink)';
        const want = { bg: getComputedStyle(probe).backgroundColor, ink: getComputedStyle(probe).color };
        probe.remove();
        const r = getComputedStyle(run);
        const plain = getComputedStyle(/** @type {Element} */ (document.getElementById('reset')));
        return { want, bg: r.backgroundColor, ink: r.color, border: r.borderTopColor, plainBg: plain.backgroundColor, on: root.getPropertyValue('--on') };
      });
      expect.soft(look.on.trim(), '--on is defined in the app').not.toBe('');
      expect.soft(look.bg, 'filled with --on').toBe(look.want.bg);
      expect.soft(look.border, 'its border is its fill').toBe(look.want.bg);
      expect.soft(look.ink, 'labeled in --on-ink').toBe(look.want.ink);
      expect.soft(contrast(look.ink, look.bg), `${look.ink} on ${look.bg}`).toBeGreaterThanOrEqual(4.5);
      expect.soft(look.bg, 'unlike the plain button beside it').not.toBe(look.plainBg);
    });
  });
