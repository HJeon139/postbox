// A headless Chrome check of the agent contract, in a real browser and a real sandboxed app frame:
//   #50: postbox.send with values over the event limit rejects inside the app, naming the limit, and nothing
//        reaches the conversation; the same hand-off by id goes through.
//
//   node tools/check-contract.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory.
// PB_PORT and PB_CHROME_PORT move it (4420 and 9620 by default), so sessions working in parallel don’t collide.

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';

const PORT = Number(process.env.PB_PORT ?? 4420);
const CHROME_PORT = Number(process.env.PB_CHROME_PORT ?? 9620);

/** Fails fast when something else already listens on a port this check needs. */
const free = (port) =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', () => fail(new Error(`Port ${port} is in use. Stop whatever is on it, or set PB_PORT and PB_CHROME_PORT.`)));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(undefined)));
  });
await free(PORT);
await free(CHROME_PORT);

// One click tries a hand-off of 1,258 pairs with their text (too large), then the same pairs by id.
const HANDOFF = `<main style="padding:12px"><button id="go" class="btn" type="button" style="display:block;width:100%;height:96px">Send all pairs</button><p id="out">Ready</p></main>
<script>
const pairs = Array.from({ length: 1258 }, (_, i) => ({ id: 'p' + i, claim: 'A claim about a protein and a disease, with its abstract. '.repeat(2) }));
document.getElementById('go').addEventListener('click', async () => {
  const st = {};
  try { await postbox.send('pairs', { pairs }, 'Sent 1,258 pairs'); st.full = 'sent'; } catch (e) { st.full = 'refused: ' + e.message; }
  try { const r = await postbox.send('pair-ids', { ids: pairs.map((p) => p.id) }, 'Sent 1,258 pair ids'); st.ids = r.held ? 'held' : 'sent'; } catch (e) { st.ids = 'refused: ' + e.message; }
  document.getElementById('out').textContent = st.full;
  postbox.saveState(st);
});
</script>`;

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-contract-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
let page = null;
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${!ok && detail ? ` (${detail})` : ''}`);
};
const until = async (fn, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

try {
  const { rt, store } = app;
  const projectId = Object.values(rt.s.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Contract check', personaIds: [rt.personaByHandle('librarian').id] });
  const se = rt.sessionsIn(t.id)[0];
  const tools = rt.toolsFor(se.id);
  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900, { theme: 'light' });
  await page.goto(`${app.origin}/#/t/${t.id}`);

  // ── #50: a hand-off over the event limit ──────────────────────────────────────────────
  const frame = `[...document.querySelectorAll('iframe.app-iframe')].find((f) => f.title === 'Hand-off')`;
  tools.show_app({ id: 'handoff', title: 'Hand-off', code: HANDOFF, permissions: [] });
  await until(() => ['passed', 'note'].includes(rt.s.apps.handoff?.check.status), 'the app to pass its check');
  await until(() => page.evaluate(`!!${frame}?.dataset.sized`), 'the app to load');
  const at = await page.evaluate(
    `(() => { const f = ${frame}; f.scrollIntoView({ block: 'center' }); const b = f.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 50 }; })()`,
  );
  await sleep(200);
  // A pointer rests on what it clicks for a moment, as a hand does; an app frame needs it to see you point (#38).
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await sleep(100);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await until(() => rt.s.apps.handoff.state?.ids, 'the app to record what its sends returned');
  const st = rt.s.apps.handoff.state;
  const sent = store.items(t.id).filter((x) => x.kind === 'voice' && x.appId === 'handoff');
  check(
    /^refused: postbox\.send: .*larger than the 64 KB one event can carry, so nothing was sent/.test(st.full),
    'a send over 64 KB rejects inside the app, naming the limit',
    st.full,
  );
  check(/Send ids instead/.test(st.full), 'the error says to send ids instead', st.full);
  check(st.ids === 'sent', 'the same hand-off by id goes through', st.ids);
  check(
    sent.length === 1 && sent[0].text === 'Sent from Hand-off: Sent 1,258 pair ids',
    'only the hand-off by id reaches the conversation',
    JSON.stringify(sent.map((x) => x.text)),
  );
} catch (e) {
  failed++;
  console.log(`FAIL ${e.message}`);
} finally {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed.` : '\nAll passed.');
process.exit(failed ? 1 : 0);
