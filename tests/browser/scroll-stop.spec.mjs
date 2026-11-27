// A step’s output and a command’s output take a tab stop only while they scroll (#1964), as a dialog’s body does: a
// long one is reached and scrolled by keyboard, and a short one is no extra stop for Tab, so opening a finished turn’s
// steps doesn’t give every step a stop. Each keeps its label either way. Steps come from the scripted backend
// (tests/browser/live-scripts.mjs), which reports through the harness-event contract.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { scriptedRoom } from './live-scripts.mjs';
import { synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'scroll-stop');
const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');

for (const width of [375, 1280]) {
  for (const [size, text, stop] of /** @type {const} */ ([
    ['short', 'ok', false],
    ['long', LONG, true],
  ])) {
    test(`#1964 at ${width} px a running step’s ${size} output ${stop ? 'takes' : 'takes no'} tab stop`, async ({ page }) => {
      const who = `step${size}${width}`;
      const t = scripted.room(`Step output, ${size}, ${width}`, [who]);
      scripted.scripts.set(who, async ({ emit }) => {
        emit({ kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'npm test' }, final: true });
        emit({ kind: 'tool_result', id: 'b1', text });
        await scripted.hold(who, 1);
      });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
      await synced(page, scripted.app);
      scripted.app.rt.sendMessage(t.id, { text: 'Run the tests.' });
      await expect.poll(() => scripted.at(who)).toBe(1);
      const output = page.locator('.live-steps .step-output');
      await expect(output).toContainText(size === 'long' ? 'line 40' : 'ok');
      await expect(output, 'labeled either way').toHaveAttribute('aria-label', /^Output of /);
      if (stop) await expect(output).toHaveAttribute('tabindex', '0');
      else await expect(output).not.toHaveAttribute('tabindex');
      scripted.go(who);
      await expect.poll(() => arrange.liveTurns(scripted.app.rt)).toBe(0);
    });

    test(`#1964 at ${width} px a command’s ${size} output ${stop ? 'takes' : 'takes no'} tab stop`, async ({ page }) => {
      const t = scripted.room(`Command output, ${size}, ${width}`, []);
      const cmd = arrange.post(scripted.app.rt, t.id, {
        kind: 'command',
        command: 'seq 40',
        cwd: '/tmp',
        status: 'done',
        text,
        exitCode: 0,
        ms: 10,
        cut: false,
      });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
      await synced(page, scripted.app);
      const output = page.locator(`[data-key="${cmd.id}"] .cmd-out`);
      await expect(output).toContainText(size === 'long' ? 'line 40' : 'ok');
      await expect(output, 'labeled either way').toHaveAttribute('aria-label', 'Output of seq 40');
      if (stop) await expect(output).toHaveAttribute('tabindex', '0');
      else await expect(output).not.toHaveAttribute('tabindex');
    });
  }
}

test('#1964 a command’s output that scrolls at 375 px loses its tab stop once the window is wide enough for it to fit', async ({ page }) => {
  const t = scripted.room('Command output, resized', []);
  // Twelve lines that each wrap at 375 px, so the box scrolls there, and fit its 320 px at 1280 px.
  const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1} ${'word '.repeat(14)}`).join('\n');
  const cmd = arrange.post(scripted.app.rt, t.id, {
    kind: 'command',
    command: 'cat notes',
    cwd: '/tmp',
    status: 'done',
    text,
    exitCode: 0,
    ms: 10,
    cut: false,
  });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  const output = page.locator(`[data-key="${cmd.id}"] .cmd-out`);
  await expect(output).toContainText('line 12');
  await expect(output, 'it scrolls at 375 px').toHaveAttribute('tabindex', '0');
  // The same box throughout: a box drawn again would start without a stop whatever the helper does.
  await output.evaluate((el) => {
    el.dataset.mark = 'same';
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => output.evaluate((el) => el.scrollHeight > el.clientHeight), { message: 'it fits at 1280 px' }).toBe(false);
  await expect(output, 'so its stop goes').not.toHaveAttribute('tabindex');
  await expect(output, 'from the same box').toHaveAttribute('data-mark', 'same');
});
