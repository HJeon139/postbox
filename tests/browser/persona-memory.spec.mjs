// #480: the persona sheet says, in one line under Backend, what each backend does with the agent’s memory: Claude Code
// and the Agent SDK keep its own, Codex’s is off, Kiro’s is off when isolated and yours with your setup, and Antigravity
// keeps its own for your sign-in. At 1280 and 375 px, from the conversation’s ⋯, where its agents are named at either
// width. A host’s lines, and an older Claude Code’s, are the unit test’s (tests/agent-memory.test.mjs).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, PHONE, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('persona-memory');
  // Stand-ins under each backend’s name, so a persona can be made on it here; none runs a turn (POSTBOX_BACKENDS=mock).
  for (const name of ['claude-code', 'agent-sdk', 'codex', 'kiro-cli', 'antigravity-cli'])
    arrange.withAdapter(app.rt, {
      name,
      async folderFor() {
        return app.root;
      },
      async deliver() {},
    });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const CASES = [
  ['claude-code', {}, 'Memory: its own. No other agent, and none of your own sessions, reads it.'],
  ['agent-sdk', {}, 'Memory: its own. No other agent, and none of your own sessions, reads it.'],
  ['codex', {}, 'Memory: off. Codex keeps one memory for everything it runs, so Postbox turns it off.'],
  ['kiro-cli', { usesHostSetup: false }, 'Memory: off. Isolated agents share one Kiro home, so Postbox turns it off there.'],
  ['kiro-cli', { usesHostSetup: true }, 'Memory: yours. With your setup, it reads and adds to your own Kiro memory.'],
  ['antigravity-cli', {}, 'Memory: Antigravity’s own, kept for your sign-in and shared with every agent on it.'],
];
let n = 0;

for (const [width, use] of /** @type {const} */ ([
  [1280, { viewport: { width: 1280, height: 800 } }],
  [375, { viewport: { width: 375, height: 812 }, ...PHONE }],
])) {
  test.describe(`at ${width} px`, () => {
    test.use(use);
    for (const [backend, extra, line] of CASES)
      test(`#480 a ${backend}${extra.usesHostSetup === false ? ' (isolated)' : ''} persona’s sheet says what it does with memory`, async ({ page }) => {
        const { rt } = app;
        const handle = `mem${++n}`;
        const p = rt.createPersona({ handle, backend, ...extra });
        const projectId = Object.values(rt.store.state.projects)[0].id;
        const t = rt.createThread({ projectId, title: `Memory ${n}`, personaIds: [p.id] });
        await page.goto(`${app.origin}/#/t/${t.id}`);
        await synced(page, app);
        await page.locator('header.topbar #conversation-actions').click();
        await page.getByRole('menuitem', { name: new RegExp(`^${handle}\\b`) }).click();
        const sheet = page.getByRole('dialog', { name: 'Settings' });
        await expect(sheet.locator('#pe-b-mem')).toHaveText(line);
        // Read with the backend, as its description is.
        await expect(sheet.locator('#pe-b')).toHaveAttribute('aria-describedby', 'pe-b-help pe-b-mem');
      });
  });
}
