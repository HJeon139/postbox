// #337: with a Postbox page open, show_app’s and update_app’s reply waits for the version’s pre-display check, which
// runs in that page, and says how it went: passed, or the problems it found. Before, the reply came back at once, and
// agents told the person a version was fixed before its check failed it. The spec calls the server’s own wait
// (server/app-check-wait.mjs, withCheck), which the MCP route calls for those two tools.

import { expect, test } from '@playwright/test';
import { withCheck } from '../../server/app-check-wait.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** Text too faint to read on its own white box, which the check holds back. */
const FAINT = '<main style="padding:12px;background:#ffffff"><p style="color:#eeeeee">Version 2</p></main>';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-check-reply');
  // The agent hears a failed check and stays at work on it, as in a real turn.
  arrange.withAdapter(app.rt, {
    name: 'mock',
    deliver: (_s, _m, ctx) =>
      new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })))),
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#337 with a page open, the reply says whether the version passed its check, and what it found when it didn’t', async ({ page }) => {
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Check in the reply',
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const shown = await withCheck(
    rt.apps,
    'show_app',
    tools.show_app({ id: 'sleep', title: 'Sleep and running', code: '<main style="padding:12px"><p>Version 1</p></main>' }),
    null,
  );
  expect(shown.message).toContain('v1 passed its check, and the person sees it.');
  const updated = await withCheck(rt.apps, 'update_app', tools.update_app({ id: 'sleep', code: FAINT, summary: 'bigger labels' }), null);
  expect(updated.check.status).toBe('fixing');
  expect(updated.message).toMatch(
    /v2’s check found problems, so the person doesn’t see it yet\. Fix them in a new version\. Don’t tell the person v2 is fixed until its check passes\.\n- /,
  );
});
