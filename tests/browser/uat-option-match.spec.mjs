// The UAT runner’s act against a real choice block (#1750): an option the tester names as its label and description
// joined with “ — ”, or by a newline, a colon or another dash (#1782), is picked by its label, as app/js/blocks.mjs
// draws it, and a name for no option still fails the step. What it reads of the block lists each chip as
// “label — description”, and each of those, sent back, picks its chip. The runner’s own code, through a stand-in for its
// page.

import { expect, test } from '@playwright/test';
import { driver } from '../../tools/uat/driver.mjs';
import * as arrange from '../arrange.mjs';
import { plainOf } from '../turn-parts.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { runnerPage } from './runner-page.mjs';

const OPTIONS = [
  { id: 'alerts', label: 'Weekly with alerts', description: 'a summary and an alert on drops' },
  { id: 'weekly', label: 'Weekly', description: 'every Monday' },
  { id: 'daily', label: 'Daily', description: 'each evening' },
  { id: 'digest', label: 'Daily — with digest', description: 'each morning' },
  { id: 'text', label: 'Text only' },
  // A label long enough that a cut at 60 characters would have left “… —” with nothing after it.
  { id: 'long', label: 'Summarize each source the reviewer flagged in the last run', description: 'with links' },
];
// What the tester sends, and the label of the option it means.
const NAMES = [
  ['Weekly — every Monday', 'Weekly'],
  ['WEEKLY — EVERY MONDAY', 'Weekly'],
  ['Text only — no chart', 'Text only'],
  ['Daily — with digest', 'Daily — with digest'],
  ['Daily — with digest — each morning', 'Daily — with digest'],
  ['Weekly with alerts', 'Weekly with alerts'],
  ['each evening', 'Daily'],
  // Joined some other way (#1782), each after another option, so each pick shows.
  ['Weekly: every Monday', 'Weekly'],
  ['each evening', 'Daily'],
  ['Weekly – every Monday', 'Weekly'],
  ['each evening', 'Daily'],
  ['Weekly - every Monday', 'Weekly'],
  ['each evening', 'Daily'],
  ['Weekly—every Monday', 'Weekly'],
  ['each evening', 'Daily'],
  ['Weekly\nevery Monday', 'Weekly'],
  // A whole label alone picks that chip, though “Weekly with alerts” is drawn first and holds it.
  ['Weekly', 'Weekly'],
  ['each evening', 'Daily'],
];

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('uat-option-match');
  arrange.withAdapter(app.rt, {
    name: 'mock',
    async deliver(session, given, ctx) {
      if (plainOf(app.rt, session.id, given).kind !== 'user') return;
      ctx.tools.show_block({ block: { id: 'how-often', type: 'choice', version: 1, fallback: 'How often?', title: 'How often?', options: OPTIONS } });
    },
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('the runner picks a choice’s option by its label when the tester names it with its description', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the UAT driver works the page through Chromium’s DevTools protocol');
  const { rt } = app;
  const thread = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Options',
    personaIds: [rt.createPersona({ handle: 'drafter' }).id],
  });
  rt.sendMessage(thread.id, { text: 'Ask me' });
  await expect.poll(() => arrange.liveTurns(rt) === 0 && rt.store.items(thread.id).some((i) => i.kind === 'block')).toBe(true);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const block = page.locator('[data-block-item]');
  const key = await block.evaluate((n) => /** @type {HTMLElement} */ (n.closest('[data-key]')).dataset.key);
  const d = driver(await runnerPage(page));
  const picked = () =>
    block.locator('.chip[aria-checked="true"]').evaluateAll((chips) => chips.map((c) => (c.querySelector('.chip-text > span') ?? c).textContent));
  for (const [name, label] of NAMES) {
    await d.act(key, { choose: [name] });
    expect(await picked(), `“${name}”`).toEqual([label]);
  }
  await expect(d.act(key, { choose: ['Dailyish — each evening'] }), 'a label that is no option’s').rejects.toThrow(
    'Couldn’t find the option “Dailyish — each evening” on screen.',
  );
  expect(await picked(), 'and nothing else is picked').toEqual(['Daily']);
  // What the tester reads: each chip as “label — description”, not the two run together (#1782), and each of those
  // names, sent back, picks its chip.
  const read = (await d.items()).find((i) => i.key === key);
  expect(read?.buttons).toEqual(
    expect.arrayContaining([
      'Weekly with alerts — a summary and an alert on drops',
      'Weekly — every Monday',
      'Daily — each evening',
      'Daily — with digest — each morning',
      'Text only',
      'Summarize each source the reviewer flagged in the last run — with links',
    ]),
  );
  for (const named of read?.buttons.filter((b) => b.includes(' — ')) ?? []) {
    await d.act(key, { choose: [named] });
    expect((await picked())[0], `“${named}” sent back`).toBe(OPTIONS.find((o) => `${o.label} — ${o.description}` === named)?.label);
  }
  // A chip pressed as a button by the name the tester reads.
  await d.act(key, { button: 'Weekly — every Monday' });
  expect((await picked())[0], 'pressed as a button').toBe('Weekly');
});
