// Checks #54 in headless Chrome: a large app goes by file, not by side channel. An app shown from codePath, with a
// data file from the agent’s folder, reads the file in its sandbox with postbox.file(name) and shows it; a raw POST
// to /mcp with only the session id, as a script would send, is refused and shows nothing; and Settings offers no
// session-id-only endpoint.
//
//   node tools/checks/app-files.mjs
//
// PB_PORT and PB_CHROME_PORT move it (4630 and 9830 by default), so sessions working in parallel don’t collide.
// It reports through tools/harness.mjs: one line per assertion, and exit code 1 on any failure.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch, sleep } from '../cdp.mjs';
import { record as check, finish, ports } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(4630, 9830);

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

const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-app-files-'));
const folder = join(dataDir, 'agent-folder');
await mkdir(folder);
process.env.POSTBOX_BACKENDS = 'mock';
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
let page = null;

try {
  const { rt, store } = app;
  const until = async (fn, label, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  const projectId = Object.values(rt.s.projects)[0].id;
  store.emit('project', { ...rt.s.projects[projectId], folder });
  const t = rt.createThread({ projectId, title: 'Files check', personaIds: [rt.personaByHandle('librarian').id] });
  const se = rt.sessionsIn(t.id)[0];
  await writeFile(join(folder, 'explorer.html'), APP);
  await writeFile(join(folder, 'pairs.json'), JSON.stringify(Array.from({ length: 1258 }, (_, i) => ({ claim: `claim ${i}` }))));

  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900, { theme: 'dark' });
  await page.goto(`${app.origin}/#/t/${t.id}`);

  // 1. The app’s code and data come from files in the agent’s folder, as an MCP call would send them.
  const { args, files } = await rt.appFiles(se.id, { id: 'pairs', title: 'Pair explorer', codePath: 'explorer.html', files: [{ path: 'pairs.json' }] });
  const shown = rt.toolsFor(se.id).show_app(args, { files });
  check(shown.ok, 'show_app takes codePath and a data file', shown.message);
  await until(() => rt.s.apps.pairs?.state?.missing, 'the app to read its files').catch(() => {});
  const st = rt.s.apps.pairs?.state ?? {};
  check(st.read === 1258 && st.first === 'claim 0', 'the app reads its data file in the sandbox with postbox.file(name)', JSON.stringify(st));
  check(
    /has no file “missing\.json”/.test(rt.s.apps.pairs?.state?.missing ?? ''),
    'a file the version doesn’t carry rejects, and says so',
    rt.s.apps.pairs?.state?.missing,
  );

  // 2. A script that knows the session id posts to /mcp, as in #54: refused, and nothing shows.
  const before = store.items(t.id).length;
  const r = await fetch(`${app.origin}/mcp?session=${encodeURIComponent(se.id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'show_app', arguments: { id: 'side', title: 'Side channel', code: '<p>from a script</p>' } },
    }),
  }).then((x) => x.json());
  check(
    r.error?.code === -32001 && /only from an agent turn it started/.test(r.error.message),
    'a tool call with only the session id is refused',
    JSON.stringify(r),
  );
  await sleep(500);
  check(store.items(t.id).length === before && !rt.s.apps.side, 'and nothing of it reaches the conversation');

  // 3. Settings no longer offers an endpoint to connect with a session id alone.
  await page.evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
  await sleep(300);
  await page.evaluate(`[...document.querySelectorAll('.dialog [role=tab], .dialog button')].find((b) => b.textContent.trim() === 'Backends')?.click()`);
  await sleep(300);
  const text = await page.evaluate(`document.querySelector('.dialog')?.innerText ?? ''`);
  check(
    /a token for each turn/.test(text) && !/mcp\?session=/.test(text),
    'Settings says each turn has a token, and shows no session-id endpoint',
    text.slice(0, 300),
  );
} catch (e) {
  check(false, 'the check ran to the end', e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
finish();
