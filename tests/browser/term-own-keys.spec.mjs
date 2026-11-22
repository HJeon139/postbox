// #247’s sibling sweep: a glossary term was known when its key was one Object has, so an agent’s undefined
// [x](term:constructor) wasn’t marked “Not defined yet”, as an undefined term is.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('term-own-keys');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#247 a term no one defined is marked undefined, whatever its key', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const librarian = arrange.persona(rt, 'librarian');
  const t = rt.createThread({ projectId, title: 'Terms', personaIds: [librarian.id] });
  const se = arrange.agentIn(rt, t.id);
  const text = 'See [the builder](term:constructor) and [the reader](term:reader).';
  arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: librarian.id, handle: 'librarian', text, status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  for (const name of ['the builder', 'the reader']) {
    const term = page.locator('.transcript .term', { hasText: name });
    await expect(term, name).toHaveClass(/\bundef\b/);
    await expect(term).toHaveAttribute('title', 'Not defined yet. The agent has been asked to define it.');
  }
});
