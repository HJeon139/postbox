// Choice options choose their shape from their measured labels (#673): labels that fit stay pills, while any label
// that would wrap makes every option a full-width panel. The measurement follows the block when its width changes,
// without changing radio, multiple-choice, number-key, focus or Other behavior.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const block = (id, options, extra = {}) => ({ id, type: 'choice', version: 1, fallback: id, options, ...extra });
const SHORT = [
  { id: 'first', label: 'First' },
  { id: 'second', label: 'Second' },
];
const LONG = [
  { id: 'local', label: 'Keep every recorded version of each local file so agents can inspect earlier contents without asking the original author' },
  { id: 'remote', label: 'Copy the requested file version to a remote host for that turn, then retain it under the room’s shared storage policy' },
];
const ADAPTIVE = [
  { id: 'now', label: 'Build the smallest compatible slice in this sprint' },
  { id: 'later', label: 'Wait for the related storage work before building it' },
];

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let drafter;
test.beforeAll(async () => {
  app = await startPostbox('choice-panels');
  arrange.withAdapter(app.rt, {
    name: 'mock',
    async deliver(_session, message, ctx) {
      if (message.kind !== 'user') return;
      ctx.tools.show_block({ block: block('long', LONG, { title: 'Long options', other: { label: 'Another approach' } }) });
      ctx.tools.show_block({ block: block('short', SHORT, { title: 'Short options', multiple: true }) });
      ctx.tools.show_block({ block: block('adaptive', ADAPTIVE, { title: 'Adaptive options' }) });
    },
  });
  drafter = app.rt.createPersona({ handle: 'drafter' });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

async function choices(page, width, title) {
  await page.setViewportSize({ width, height: 800 });
  const { rt } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title, personaIds: [drafter.id] });
  rt.sendMessage(thread.id, { text: 'Show the choices' });
  await expect.poll(() => arrange.liveTurns(rt) === 0 && rt.store.items(thread.id).filter((i) => i.kind === 'block').length === 3).toBe(true);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const item = (id) => rt.store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === id);
  return (id) => page.locator(`[data-block-item="${item(id).id}"]`);
}

for (const width of [375, 1280])
  test(`#673 at ${width}px, wrapping labels use panels and short choices keep their semantics`, async ({ page }) => {
    const choice = await choices(page, width, `Choices at ${width}`);
    const long = choice('long');
    const longOptions = long.locator('.chips');
    await expect(longOptions, 'one wrapping label makes every option a panel').toHaveClass(/panels/);
    await expect(longOptions.getByRole('radio')).toHaveCount(3);
    await settled(page);
    const panels = await longOptions.evaluate((list) => ({
      width: list.getBoundingClientRect().width,
      options: [...list.querySelectorAll('.chip')].map((option) => {
        const box = option.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          containsText: option.scrollWidth <= option.clientWidth && option.scrollHeight <= option.clientHeight,
        };
      }),
    }));
    expect(
      panels.options.every(
        (option, i) => option.containsText && Math.abs(option.width - panels.width) < 1 && (i === 0 || option.top > panels.options[i - 1].bottom),
      ),
      'every panel is a full row and contains its wrapped text',
    ).toBe(true);

    const first = long.getByRole('radio', { name: LONG[0].label });
    await first.focus();
    const second = long.getByRole('radio', { name: LONG[1].label });
    await page.keyboard.press('ArrowRight');
    await expect(second, 'arrow keys still move among options').toBeFocused();
    await page.keyboard.press('1');
    await expect(first, 'number keys still select their option').toHaveAttribute('aria-checked', 'true');
    await expect(second, 'a selection re-render keeps focus where it was').toBeFocused();
    const other = long.getByRole('radio', { name: 'Another approach' });
    await other.click();
    await expect(long.getByRole('textbox', { name: 'Another approach' }), 'Other still opens its field').toBeVisible();
    await first.click();
    await expect(other, 'a regular option turns Other off').toHaveAttribute('aria-checked', 'false');
    await expect(long.getByRole('textbox', { name: 'Another approach' }), 'a regular option closes Other’s field').toHaveCount(0);

    const short = choice('short').locator('.chips');
    await expect(short, 'short labels stay pills').not.toHaveClass(/panels/);
    await expect(short.locator('.chip[aria-pressed]'), 'multiple choices keep toggle-button semantics').toHaveCount(2);
  });

test('#673 choice shape is measured again when the block width changes', async ({ page }) => {
  const choice = await choices(page, 1280, 'Choices resized');
  const adaptive = choice('adaptive').locator('.chips');
  await expect(adaptive, 'the labels fit at the wide width').not.toHaveClass(/panels/);
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(adaptive, 'the same labels become panels at the narrow width').toHaveClass(/panels/);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(adaptive, 'the same labels return to pills when room returns').not.toHaveClass(/panels/);
});
