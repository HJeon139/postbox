// The pre-display check holds back a visual that can’t be read, and tells the agent which elements to fix (#997):
// labels drawn over each other and a figure below the first view at 1000 × 680. A page that shows its title and figure
// at once pass. Every app goes up in one conversation, which a page opened before the tests checks; each test reads
// what the check found, and what the agent was sent.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

failOnPageErrors(test);

const T = 'fill="var(--text)" font-size="14"';
const APPS = {
  // Two labels drawn over each other.
  overlap: `<svg width="320" height="60" role="img" aria-label="Labels"><text class="a" x="20" y="30" ${T}>Median income</text><text class="b" x="30" y="34" ${T}>Mean income</text></svg>`,
  // The title, then a block of notes 700 px tall, then the figure: at 1000 × 680, none of the figure shows.
  below: `<h1 style="color:var(--text);margin:8px">Sleep sets the pace</h1><div class="notes" style="height:700px;color:var(--text)">Notes</div>
<svg id="pace" width="600" height="300" role="img" aria-label="Pace"><circle cx="300" cy="150" r="40" fill="var(--accent)"/></svg>`,
  // The title and a 400 px figure 340 px wide, with its labels at 12 px and over beside its marks: everything shows at once.
  good: `<h1 style="color:var(--text);margin:8px;font-size:22px">Sleep sets the pace</h1>
<svg width="340" height="400" role="img" aria-label="Pace by sleep">${[0, 1, 2, 3]
    .map(
      (i) =>
        `<circle cx="${20 + i * 75}" cy="${300 - i * 60}" r="8" fill="var(--accent)"/><text x="${32 + i * 75}" y="${304 - i * 60}" ${T}>${6 + i} hours</text>`,
    )
    .join('')}</svg>`,
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

test('#997 a figure below the first view at 1000 × 680 is held back, naming it', () => {
  expect(heldFor('below', 'first-view'), says('below')).toEqual([
    expect.stringMatching(/^At 1000 × 680 px, before any scrolling, 0% of the figure \(svg#pace, 600 × 300 px/),
  ]);
});

test('#997 a title and a figure on screen at once, with labels at 12 px or more beside their marks, pass', () => {
  expect(check('good').status, says('good')).toBe('passed');
});
