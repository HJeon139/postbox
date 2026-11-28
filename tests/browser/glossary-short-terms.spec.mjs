// A short term links only as itself, and a dash variant links the same term (#102). A term “R” linked inside “R&D”, a
// term “U” inside “U.S.” and a lowercase “u”, and a term “U:45–52” missed “U:45-52” typed with a hyphen.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('glossary-short-terms', { demo: false });
  app.store.emit('project', { id: 'pr_short', name: 'Short terms', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#102 a short term links as itself and not inside an abbreviation, and a dash variant links the same term', async ({ page }) => {
  const { rt } = app;
  const p = rt.createPersona({ handle: 'reader' });
  const t = rt.createThread({ projectId: 'pr_short', title: 'Short terms', personaIds: [p.id] });
  const se = arrange.agentIn(rt, t.id);
  const define = rt.toolsFor(se.id).define_term;
  define({ term: 'R', definition: 'The requirements document.' });
  define({ term: 'U', definition: 'The user study.' });
  define({ term: 'U:45–52', definition: 'The user study, lines 45 to 52.' });
  const text = 'The R&D team read R and the U.S. notes, see u later. U said so in U:45-52.';
  arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const reply = page.locator(`.transcript[data-thread="${t.id}"] .md`, { hasText: 'R&D' });
  await expect(reply).toBeVisible();
  // Each linked term, in order: “R” as a word, “U” as a word, and the hyphen form of “U:45–52”.
  await expect(reply.locator('.term'), 'the terms linked').toHaveText(['R', 'U', 'U:45-52']);
  await expect(reply.locator('.term').nth(2), 'the hyphen form links the en-dash term').toHaveAttribute('data-term', /u-45-52|U:45–52/i);
});

test('#102 an earlier reply links a term defined later with a different dash or quote, without a reload', async ({ page }) => {
  const { rt } = app;
  const p = rt.createPersona({ handle: 'later' });
  const t = rt.createThread({ projectId: 'pr_short', title: 'Later terms', personaIds: [p.id] });
  const se = arrange.agentIn(rt, t.id);
  const define = rt.toolsFor(se.id).define_term;
  const text = "Per U:45-52 and Bob's rule.";
  arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const reply = page.locator(`.transcript[data-thread="${t.id}"] .md`, { hasText: 'Per U:45' });
  await expect(reply).toBeVisible();
  // The lint’s flow: the reply comes first, then the agent defines each term, here with an en dash and a curly quote.
  define({ term: 'U:45–52', definition: 'The user study, lines 45 to 52.' });
  define({ term: 'Bob’s rule', definition: 'The rule Bob set.' });
  await expect(reply.locator('.term'), 'both terms, linked in the reply already drawn').toHaveText(['U:45-52', "Bob's rule"]);
});
