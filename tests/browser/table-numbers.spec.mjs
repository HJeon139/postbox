// #836: a table block showed a year column as “2,023”. A number column groups its digits, as an amount should, but a
// column named for a year or an id shows its whole numbers as written.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let t;

test.beforeAll(async () => {
  app = await startPostbox('table-numbers');
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  t = rt.createThread({ projectId: project.id, title: 'Paper survey', personaIds: [rt.personaByHandle('librarian').id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.toolsFor(se.id).show_block({
    block: {
      id: 'papers',
      type: 'table',
      version: 1,
      title: 'Papers',
      fallback: 'Papers',
      columns: [
        { id: 'title', label: 'Paper' },
        { id: 'year', label: 'Year', kind: 'number' },
        { id: 'pid', label: 'Paper ID', kind: 'number' },
        { id: 'cites', label: 'Citations', kind: 'number' },
        { id: 'score', label: 'Score', kind: 'number' },
        { id: 'rev', label: 'Revenue per year', kind: 'number' },
        { id: 'founded', label: 'Year founded', kind: 'number' },
        { id: 'ye', label: 'Year-end revenue', kind: 'number' },
      ],
      rows: [{ id: 'r1', cells: { title: 'ReAct', year: 2023, pid: 10427, cites: 12345, score: 0.5, rev: 1234567, founded: 1999, ye: 7654321 } }],
    },
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#836 a year and an id show as written; a count, an amount per year and a year-end amount keep their thousands separators (#844)', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const row = page.locator('.transcript table tbody tr').first();
  await expect(row.locator('td')).toHaveText(['ReAct', '2023', '10427', '12,345', '0.5', '1,234,567', '1999', '7,654,321']);
});
