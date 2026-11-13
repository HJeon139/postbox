// #822: a form’s number field with a min or a max said nothing about them until a submit failed, so a person who
// typed “About 600 words” got an error and had to try again. The field now shows its range under it before any
// submit, in the words the error uses, and the input is described by it. An agent’s own help and placeholder still
// show, and the error after a bad submit stays as it was.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced, windowWidth } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let n = 0;

test.beforeAll(async () => {
  app = await startPostbox('number-range');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const cases = [
  { what: 'a min and a max', range: { min: 500, max: 10000 }, hint: 'From 500 to 10,000.', error: 'Enter a number from 500 to 10,000.' },
  { what: 'only a min', range: { min: 500 }, hint: 'At least 500.', error: 'Enter a number of at least 500.' },
  { what: 'only a max', range: { max: 10000 }, hint: 'No more than 10,000.', error: 'Enter a number no more than 10,000.' },
];

for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width === 375 ? 812 : 900 } });
    for (const c of cases) {
      test(`#822 a number field with ${c.what} shows “${c.hint}” before any submit, and is described by it`, async ({ page }) => {
        const { rt } = app;
        const project = Object.values(rt.store.state.projects)[0];
        const thread = rt.createThread({ projectId: project.id, title: `Length ${++n}`, personaIds: [arrange.persona(rt, 'librarian').id] });
        const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
        const field = { id: 'words', label: 'Rough length you want', kind: 'number', ...c.range, help: 'Words, roughly.', placeholder: '600' };
        tools.show_block({ block: { id: 'length', type: 'form', version: 1, title: 'The essay', fallback: 'How long?', fields: [field] } });
        await page.goto(`${app.origin}/#/t/${thread.id}`);
        await synced(page, app);
        const block = page.locator('.transcript .block', { hasText: 'The essay' });
        const input = block.getByRole('textbox', { name: 'Rough length you want' });
        const hint = block.getByText(c.hint, { exact: true });
        await expect.soft(hint, 'the range shows before any submit').toBeVisible();
        const said = c.hint.replace('.', '\\.');
        await expect
          .soft(input, 'the input is described by the range and the agent’s help')
          .toHaveAccessibleDescription(new RegExp(`${said}.*Words, roughly\\.|Words, roughly\\..*${said}`));
        await expect.soft(input, 'the agent’s placeholder still shows').toHaveAttribute('placeholder', '600');
        await expect.soft(block.getByText('Words, roughly.', { exact: true }), 'the agent’s help still shows').toBeVisible();
        // Measured only when the soft check above found it, so a missing range doesn’t wait out the test.
        const box = (await hint.count()) ? await hint.boundingBox() : null;
        expect.soft(box && box.x + box.width <= windowWidth(page), 'the range fits the window').toBe(true);

        // The server refuses the bad submit, as it should, and the page logs that.
        allowPageError(page, /status of 422/);
        await input.click();
        await page.keyboard.type('About 600 words');
        await block.getByRole('button', { name: 'Send form' }).click();
        const error = block.getByText(c.error, { exact: true });
        await expect.soft(error, 'the error after a bad submit stays as it was').toBeVisible();
        expect.soft(c.error, 'the error uses the range’s words').toContain(`${c.hint[0].toLowerCase()}${c.hint.slice(1)}`);
        await expect.soft(input).toHaveAccessibleDescription(new RegExp(c.error.replace('.', '\\.')));
      });
    }
  });
}
