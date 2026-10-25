// A headless Chrome check of the turn’s list (#195): under the turn’s last reply, its line and a row per thing it did,
// in the ledger’s order, matching Work; “N more” expands in place; each row opens Work full screen at its item, and
// Escape comes back to the row, where the conversation was; a long path keeps its file name at 375 px; and axe finds
// nothing in the list or in Work’s new sections. Every case runs at 1280 and at 375 px.
//
//   node tools/check-work-list.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory, and has the
// mock @researcher do the demo’s first turn of work in “Citation fixes”: it reads two files, changes four, runs four
// commands, files an issue and shows an app. PB_PORT and PB_CHROME_PORT move it.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { turnLine } from '../shared/work.mjs';
import { turnRows } from '../shared/work-list.mjs';
import { js, launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4860, 10160);

process.env.POSTBOX_BACKENDS = 'mock';
process.env.POSTBOX_MOCK_SPEED = '0.1';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-work-list-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;
const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const q = (sel) => `document.querySelector(${js(sel)})`;
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
async function press(key) {
  const code = { Escape: 27, Enter: 13 }[key];
  const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
/** A real click at the element’s middle, which must be the element itself and not something over it. */
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); const x = b.x + Math.min(b.width / 2, 40), y = b.y + b.height / 2; const at = document.elementFromPoint(x, y); return { x, y, ok: !!at && (at === el || el.contains(at)), at: at?.outerHTML.slice(0, 120) }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  assert.ok(r.ok, `Something covers ${expr}: ${r.at}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
async function check(name, fn) {
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 90 s')), 90000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
}
async function axe(sel, where) {
  await page.evaluate(`${AXE};0`);
  const found = await page.evaluate(
    `axe.run({ include: [[${js(sel)}]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] }).then((r) => r.violations.map((v) => v.id + ': ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')))`,
  );
  assert.deepEqual(found, [], `axe, ${where}`);
}
const waitUntil = async (fn, label, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

// ── One turn of work ────────────────────────────────────────────────────────────────────

const conv = Object.values(store.state.threads).find((t) => t.title === 'Citation fixes');
rt.sendMessage(conv.id, { text: 'Fix the citation script' });
await waitUntil(() => store.items(conv.id).some((i) => i.work), 'the turn’s list');
const entries = () => store.state.work[conv.id];
const turn = entries().find((e) => e.kind === 'turn');
const items = store.items(conv.id).filter((i) => i.turnId === turn.id);
const last = items.findLast((i) => i.kind === 'agent' || i.kind === 'block');
const rows = turnRows(entries(), turn.id, { folders: [store.state.projects[conv.projectId].folder] });
const LIST = `[data-key="${last.id}"] .work-list-turn`;
const ROW = (n) => `document.querySelectorAll(${js(`${LIST} .wl-row`)})[${n}]`;

await page.goto(`${app.origin}/#/t/${conv.id}`);
await page.waitFor(q('header.topbar'));

for (const [width, height] of [
  [1280, 900],
  [375, 812],
]) {
  const at = `${width} px`;
  await page.size(width, height);
  await page.evaluate(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pb-work-')) localStorage.removeItem(k); })()`);
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = ${js(`#/t/${conv.id}`)}`);
  await page.reload();
  await page.waitFor(q(`${LIST} ul`), { label: 'the list under the turn’s last reply' });
  await settle();

  await check(`${at}: the list is under the turn’s last reply only, its line on top, its rows in the ledger’s order`, async () => {
    assert.equal(await page.evaluate(`document.querySelectorAll('.transcript .work-list-turn').length`), 1, 'a list elsewhere in the turn');
    assert.equal(last.kind, 'agent', 'the turn ends with its reply');
    assert.equal(await page.evaluate(`${q(`${LIST} .work-chip`)}.textContent`), turnLine(entries(), turn.id));
    assert.equal(await page.evaluate(`${q(`${LIST} ul`)}.getAttribute('aria-label')`), 'What this turn did');
    const kinds = [...new Set(rows.map((r) => r.kind))];
    assert.deepEqual(kinds, ['file', 'publish', 'external', 'command', 'reads'], 'files, the app, the issue, the commands, then reads');
    assert.equal(await page.evaluate(`document.querySelectorAll(${js(`${LIST} .wl-row`)}).length`), 5, 'five rows before “more”');
    assert.equal(await page.evaluate(`${q(`${LIST} .wl-more`)}.textContent`), `${rows.length - 5} more`);
  });

  await check(`${at}: “N more” expands in place, with focus on the first row it showed, and the rows match Work`, async () => {
    await click(q(`${LIST} .wl-more`));
    await page.waitFor(`document.querySelectorAll(${js(`${LIST} .wl-row`)}).length === ${rows.length}`, { label: 'every row' });
    assert.equal(await page.evaluate(`document.activeElement === ${ROW(5)}`), true, 'focus isn’t on the sixth row');
    const shown = await page.evaluate(`[...document.querySelectorAll(${js(`${LIST} .wl-row`)})].map((a) => a.dataset.at)`);
    assert.deepEqual(
      shown,
      rows.map((r) => r.at),
    );
    assert.match(await page.evaluate(`${q(`${LIST} .wl-command`)}.textContent`), /^Ran the citation script|node cite\.mjs refs\.bib/);
    assert.equal(await page.evaluate(`${q(`${LIST} .wl-reads`)}.textContent`), 'Read 2 files');
  });

  const back = width >= 768 ? 'comes back to the row, where the conversation was' : 'leaves Work in the pane over the conversation (#233)';
  await check(`${at}: each row opens Work full screen at its item, and Escape ${back}`, async () => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const top = await page.evaluate('scrollY');
      await click(ROW(i));
      await page.waitFor(`document.querySelector('.pane-full .work-view')`, { label: `Work full screen for row ${i}` });
      await page.waitFor(`location.hash.includes('full=work') && location.hash.includes('at=${encodeURIComponent(r.at)}')`, {
        label: `the address at ${r.at}`,
      });
      const target = await page.evaluate(`(() => { const a = document.activeElement; return !!a && (a.id === 'wsum-${r.at}' || a.id === '${r.at}'); })()`);
      assert.ok(
        target,
        `row ${i} (${r.kind}) didn’t open Work at ${r.at}: focus is on ${await page.evaluate('document.activeElement?.outerHTML.slice(0, 100)')}`,
      );
      if (i === 0) await axe('.pane-full .work-view', `${at}, full-screen Work`);
      await press('Escape');
      await page.waitFor(`!document.querySelector('.pane-full')`, { label: 'Work back in the pane' });
      if (width >= 768) {
        assert.equal(await page.evaluate(`document.activeElement === ${ROW(i)}`), true, `focus didn’t come back to row ${i}`);
        assert.ok(Math.abs((await page.evaluate('scrollY')) - top) < 400, 'the conversation scrolled away');
      }
      // Work stays open in the pane; at 375 it covers the conversation, so close it to reach the next row.
      if (width < 768) {
        await click(q('#work-close'));
        await page.waitFor(`!document.querySelector('aside.workpane')`);
      }
    }
  });

  await check(`${at}: a long path keeps its file name, nothing scrolls sideways, and axe finds nothing in the list`, async () => {
    const cut = await page.evaluate(
      `[...document.querySelectorAll(${js(`${LIST} .wl-file`)})].map((a) => { const n = a.querySelector('.wl-name'); const b = n.getBoundingClientRect(); const row = a.getBoundingClientRect(); return { name: n.textContent, whole: n.scrollWidth <= n.clientWidth + 1 && b.right <= row.right + 1 }; })`,
    );
    assert.ok(cut.length >= 4, 'the four files');
    for (const f of cut) assert.ok(f.whole, `${f.name} is cut`);
    assert.ok(
      cut.some((f) => f.name === 'notes.md'),
      'the note outside the project',
    );
    assert.ok((await page.evaluate('document.documentElement.scrollWidth')) <= width + 1, 'the page scrolls sideways');
    await axe(LIST, at);
  });

  if (width >= 768)
    await check(`${at}: a row follows the ledger after the turn: a background command that ends, and an app retired, say so`, async () => {
      const bg = entries().find((e) => e.kind === 'command' && e.background);
      const sel = `#wl-${turn.id}-${bg.id}`;
      assert.match(await page.evaluate(`${q(sel)}.textContent`), /didn’t report how it ended/);
      rt.ledger.jobUpdate({ threadId: conv.id, toolUseId: bg.toolUseId }, { state: 'stopped', by: 'you' });
      await page.synced(store.state.seq);
      await page.waitFor(`/stopped$/.test(${q(sel)}.textContent)`, { label: 'the row to say stopped' });
      // An app retired after the turn (#193): its row says so.
      const pub = entries().find((e) => e.kind === 'publish');
      store.emit('app', { ...store.state.apps[pub.blockId], retired: { by: 'researcher', reason: 'Superseded.', replacedBy: null, at: Date.now() } });
      await page.synced(store.state.seq);
      await page.waitFor(`/v1 · retired$/.test(${q(`#wl-${turn.id}-${pub.id}`)}.textContent)`, { label: 'the app’s row to say retired' });
    });
}

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
finish();
