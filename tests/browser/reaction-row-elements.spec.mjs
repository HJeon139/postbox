// The reaction row in six elements (#1060, from the person’s Firefox profiles): the five buttons, always
// shown (#320), each drawing its own icon and count, so a row adds 6 elements to every item, not 11. In a 300-item room
// on main the rows were 3,300 of 7,850 elements, 42%, which something that searches every element on each key (a
// browser extension, in the maintainer’s profile) pays for. The icons are the colored PNGs, and they paint in forced
// colors too, checked by what is painted rather than by a property (#1068).

import { expect, test } from '@playwright/test';
import { toggleReaction } from '../../server/reactions.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let thread;
/** @type {any} */
let critic;
/** @type {any} */
let message;

test.beforeAll(async () => {
  app = await startPostbox('reaction-row-elements');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_rre', name: 'Reaction row', folder: app.root });
  const persona = rt.createPersona({ handle: 'judge', backend: 'mock', permissionMode: 'auto', tools: [] });
  thread = rt.createThread({ projectId: 'pr_rre', title: 'Reaction row', personaIds: [persona.id] });
  critic = rt.sessionsIn(thread.id)[0];
  message = rt.addItem(thread.id, {
    kind: 'agent',
    sessionId: critic.id,
    personaId: persona.id,
    handle: 'judge',
    turnId: 'turn_r',
    text: 'Here is the plan.',
    status: 'done',
  });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const row = (page) => page.locator(`.transcript > [data-key="${message.id}"] .react-row`);
const button = (page, name) => row(page).getByRole('button', { name: new RegExp(`^${name}\\b`) });
/** The button as painted, and as painted with one pseudo-element hidden: they differ only if that part paints. */
async function paints(page, loc, which) {
  const shown = await loc.screenshot({ animations: 'disabled' });
  await page.addStyleTag({ content: `.react-btn${which} { visibility: hidden !important; }` });
  const hidden = await loc.screenshot({ animations: 'disabled' });
  await page.evaluate(() => document.querySelector('style:last-of-type')?.remove());
  return !shown.equals(hidden);
}
/** A pseudo-element’s computed style, by property. */
const pseudo = (loc, which, prop) => loc.evaluate((el, [w, p]) => getComputedStyle(el, w).getPropertyValue(p), [which, prop]);

for (const width of [375, 1280])
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test.beforeEach(async ({ page }) => {
      app.rt.store.emit('item.patch', { threadId: thread.id, id: message.id, patch: { reactions: [] }, reaction: { emoji: '👍', on: false, at: Date.now() } });
      await page.goto(`${app.origin}/#/t/${thread.id}`);
      await synced(page, app);
      await expect(row(page)).toBeVisible();
    });

    test('an item with no reactions holds six elements in its row: the row and its five buttons', async ({ page }) => {
      const n = await row(page).evaluate((r) => 1 + r.getElementsByTagName('*').length);
      expect(n, 'elements in the reaction row').toBe(6);
      await expect(row(page).getByRole('button')).toHaveCount(5);
    });

    test('each button draws its own icon, and a count from another shows as the button’s, not an element’s', async ({ page }) => {
      const good = button(page, 'Good');
      expect(await pseudo(good, '::before', 'background-image'), 'the icon').toMatch(/reaction-approve/);
      expect(await pseudo(good, '::before', 'width'), 'the icon’s box, the theme’s own').toMatch(/^(20|22\.5)px$/);
      toggleReaction(app.rt, thread.id, message.id, '🚩', { id: critic.id, handle: 'judge' });
      await synced(page, app);
      const flag = button(page, 'Flag this');
      await expect(flag).toHaveAttribute('data-count', '1');
      expect(await pseudo(flag, '::after', 'content'), 'the count, drawn by the button').toBe('"1"');
      await expect(good, 'no count where nobody reacted').not.toHaveAttribute('data-count', /./);
    });

    test('a count from another is painted beside the icon, and kept out of what a screen reader reads', async ({ page }) => {
      toggleReaction(app.rt, thread.id, message.id, '🚩', { id: critic.id, handle: 'judge' });
      await synced(page, app);
      const flag = button(page, 'Flag this');
      await expect(flag).toHaveAttribute('data-count', '1');
      expect(await paints(page, flag, '::after'), 'the count paints').toBe(true);
      // The button’s name already says how many; the drawn count stays out of the tree, as its aria-hidden span did.
      expect(await flag.ariaSnapshot()).not.toMatch(/: "1"/);
    });

    for (const theme of ['dark', 'light'])
      test(`the icon paints in forced colors, on ${theme}`, async ({ page }) => {
        await page.emulateMedia({ forcedColors: 'active' });
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        expect(await paints(page, button(page, 'Good'), '::before'), 'the icon paints').toBe(true);
      });

    for (const theme of ['dark', 'light'])
      test(`in forced colors the icon is the theme’s own, on ${theme}`, async ({ page }) => {
        await page.emulateMedia({ forcedColors: 'active' });
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        const good = button(page, 'Good');
        expect(await pseudo(good, '::before', 'background-image')).toMatch(theme === 'light' ? /reaction-approve-rim/ : /reaction-approve-64/);
      });
  });
