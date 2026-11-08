// The pre-display check holds back a visual that can’t be read, and tells the agent which elements to fix (#997):
// labels drawn over each other. Every app goes up in one conversation, which a page opened before the tests checks;
// each test reads what the check found, and what the agent was sent.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

failOnPageErrors(test);

const T = 'fill="var(--text)" font-size="14"';
const APPS = {
  // Two labels drawn over each other.
  overlap: `<svg width="320" height="60" role="img" aria-label="Labels"><text class="a" x="20" y="30" ${T}>Median income</text><text class="b" x="30" y="34" ${T}>Mean income</text></svg>`,
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What each app’s agent was sent about its check, by app id. */
const sent = {};
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  app = await startPostbox('app-check-readable');
  const { rt } = app;
  // The agent hears a failed check and doesn’t answer, so each app keeps what its first check found.
  rt.adapters.register({
    name: 'mock',
    async deliver(_s, message) {
      if (message.kind === 'app-check') sent[message.appId] = message.problems;
    },
  });
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: 'Readable', personaIds: [rt.createPersona({ handle: 'drawer' }).id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  for (const [id, code] of Object.entries(APPS)) tools.show_app({ id, title: id, code });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
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
/**
 * The messages of one code the agent was sent, once: the check held the version back for the agent to fix. (Its mock
 * turn ends without a new version, so the app is shown with a note after.)
 */
function heldFor(id, code) {
  expect.soft(check(id).attempt, `${id} went back to the agent once: ${says(id)}`).toBe(1);
  return (sent[id] ?? []).filter((p) => p.code === code).map((p) => p.message);
}

test('#997 labels drawn over each other are held back, naming both', () => {
  expect(heldFor('overlap', 'text-overlap')[0], says('overlap')).toMatch(/“Median income” \([^)]*text\.a\) is drawn over “Mean income” \([^)]*text\.b\)/);
});
