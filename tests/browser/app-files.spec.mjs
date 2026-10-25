// A large app and its data go by file, not by side channel (#54, #47): an app shown from codePath, with a data file
// from the agent’s folder, reads the file in its sandbox with postbox.file(name); a raw POST to /mcp with only the
// session id, as a script would send, is refused and shows nothing; a dataset the agent loads from the project’s
// .postbox/datasets/ shows a line and reaches an app with no restart, but not a search that doesn’t name it; and
// Settings offers no session-id-only endpoint. Moved from tools/checks/app-files.mjs (#303).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// Reads its data file once it’s shown (not during the check), and keeps what it found in saved state.
const APP = `<main style="padding:12px"><p id="out">Loading the pairs…</p></main>
<script>
postbox.ready.then(async () => {
  const out = document.getElementById('out');
  const st = {};
  try {
    const pairs = JSON.parse(await postbox.file('pairs.json'));
    out.textContent = pairs.length + ' pairs, the first about ' + pairs[0].claim;
    Object.assign(st, { read: pairs.length, first: pairs[0].claim });
  } catch (e) {
    out.textContent = 'Couldn’t read the pairs: ' + e.message;
    st.error = e.message;
  }
  await postbox.file('missing.json').catch((e) => { st.missing = e.message; });
  if (!postbox.check) postbox.saveState(st);
});
</script>`;

// Reads a record of the dataset by id, and searches it by name and without.
const READER = `<p id="out">…</p><script>
postbox.ready.then(async () => {
  const one = await postbox.query('corpus.read', { id: 'scifact:c7' });
  const named = await postbox.query('corpus.search', { query: 'vitamin', books: ['scifact'] });
  const plain = await postbox.query('corpus.search', { query: 'vitamin' });
  document.getElementById('out').textContent = one.text;
  if (!postbox.check) postbox.saveState({ text: one.text, named: named.length, plain: plain.filter((h) => h.book === 'scifact').length });
});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let folder;
let projectId;
test.beforeAll(async () => {
  app = await startPostbox('app-files');
  const { rt, store } = app;
  folder = join(app.root, 'agent-folder');
  await mkdir(folder);
  projectId = Object.values(rt.s.projects)[0].id;
  store.emit('project', { ...rt.s.projects[projectId], folder });
  await writeFile(join(folder, 'explorer.html'), APP);
  await writeFile(join(folder, 'pairs.json'), JSON.stringify(Array.from({ length: 1258 }, (_, i) => ({ claim: `claim ${i}` }))));
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });

/** A conversation of its own with the librarian, open in the page; its id and the librarian’s session. */
async function room(page, title) {
  const { rt } = app;
  const t = rt.createThread({ projectId, title, personaIds: [rt.personaByHandle('librarian').id] });
  const [se] = rt.sessionsIn(t.id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  return { t, se };
}
/** An app’s saved state, once it has saved what it found. */
const saved = (id, key) =>
  expect.poll(() => app.rt.s.apps[id]?.state?.[key], { message: `the app “${id}” to save what it found`, timeout: 15_000 }).toBeTruthy();

test('#54 an app shown from codePath reads its data file in the sandbox, and a file it doesn’t carry rejects', async ({ page }) => {
  const { rt } = app;
  // The app asks for missing.json on purpose, from its frame and its check’s: the server answers 404.
  allowPageError(page, /status of 404/, { times: 3 });
  const { se } = await room(page, 'Files');
  const { args, files } = await rt.appFiles(se.id, { id: 'pairs', title: 'Pair explorer', codePath: 'explorer.html', files: [{ path: 'pairs.json' }] });
  const shown = rt.toolsFor(se.id).show_app(args, { files });
  expect(shown.ok, shown.message).toBe(true);
  await expect(page.frameLocator('.transcript .appframe iframe').locator('#out')).toHaveText('1258 pairs, the first about claim 0');
  await saved('pairs', 'missing');
  const st = rt.s.apps.pairs.state;
  expect([st.read, st.first]).toEqual([1258, 'claim 0']);
  expect(st.missing).toMatch(/has no file “missing\.json”/);
});

test('#54 a tool call to /mcp with only the session id is refused, and nothing of it reaches the conversation', async ({ page }) => {
  const { rt, store } = app;
  const { t, se } = await room(page, 'Side channel');
  const before = store.items(t.id).length;
  // As a script that knows the session id would send it.
  const res = await fetch(`${app.origin}/mcp?session=${encodeURIComponent(se.id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'show_app', arguments: { id: 'side', title: 'Side channel', code: '<p>from a script</p>' } },
    }),
  });
  const r = await res.json();
  expect(r.error?.code, JSON.stringify(r)).toBe(-32001);
  expect(r.error.message).toMatch(/only from an agent turn it started/);
  await synced(page, app);
  expect(store.items(t.id).length).toBe(before);
  expect(rt.s.apps.side).toBeUndefined();
  await expect(page.locator('.transcript .appframe')).toHaveCount(0);
});

test('#47 a dataset the agent loads shows a line, and reaches an app with no restart, but not a search that doesn’t name it', async ({ page }) => {
  const { rt } = app;
  const { se } = await room(page, 'Datasets');
  await mkdir(join(folder, '.postbox', 'datasets'), { recursive: true });
  await writeFile(
    join(folder, '.postbox', 'datasets', 'scifact.jsonl'),
    Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: `c${i}`, text: `Claim ${i} about vitamin D and fractures.` })).join('\n'),
  );
  const loaded = await rt.toolsFor(se.id).add_dataset({ id: 'scifact', path: 'scifact.jsonl', title: 'SciFact claims' });
  expect(loaded.ok, loaded.message).toBe(true);
  await expect(
    page.locator('.sys-line', { hasText: /@librarian loaded the dataset scifact · 50 records, searched only when named/ }),
    'the conversation says the agent loaded it, and that it’s searched only when named',
  ).toBeVisible();
  rt.toolsFor(se.id).show_app({ id: 'reader', title: 'Reader', code: READER, permissions: ['corpus.read', 'corpus.search'] });
  await saved('reader', 'text');
  const rd = rt.s.apps.reader.state;
  expect(rd.text).toBe('Claim 7 about vitamin D and fractures.');
  expect(rd.named, 'a search that names it gets it').toBeGreaterThan(0);
  expect(rd.plain, 'a search that doesn’t name it doesn’t get it').toBe(0);
});

test('#54 Settings says each turn has a token, and shows no session-id endpoint', async ({ page }) => {
  await room(page, 'Settings');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.locator('.dialog');
  await dialog.getByRole('tab', { name: 'Backends' }).click();
  await expect(dialog).toContainText('a token for each turn');
  await expect(dialog).not.toContainText('mcp?session=');
});
