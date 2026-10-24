// A headless Chrome check of the Work view for an agent on a remote host (#120, the plan’s L7): one line per host
// says its files aren’t recorded, with the host’s name; the files the agent edited there are listed without lines,
// a diff or Restore, in the pane, in a turn and full screen; a host’s commit doesn’t claim to be pushed or not;
// axe finds nothing; and nothing scrolls sideways. Every case runs at 1280 and at 375 px.
//
//   node tools/check-work-remote.mjs
//
// It starts its own server with the demo seed on a fresh data folder in the temp directory, adds a host, and feeds
// the server’s own work ledger two recorded Claude Code turns (tests/fixtures/claude-code/ledger-*.jsonl) as a
// turn on that host, the way the runtime does for a remote persona. No host or SSH is involved. PB_PORT and
// PB_CHROME_PORT move it, so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4760, 9960);
const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
  .then((r) => r.violations.map((v) => v.id + ' (' + v.impact + '): ' + v.help + ' at ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')))`;

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-work-remote-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

// ── A conversation whose agent ran two turns on a host ─────────────────────────────────

const host = rt.addHost({ name: 'host.example.com' });
const project = Object.values(store.state.projects)[0];
const persona = rt.createPersona({ handle: 'builder' });
const conv = rt.createThread({ projectId: project.id, title: 'Remote build', personaIds: [persona.id] });
const se = rt.sessionsIn(conv.id).find((x) => x.personaId === persona.id);
const fixture = async (name) =>
  (await readFile(new URL(`../tests/fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const turnIds = [];
for (const name of ['ledger-edits', 'ledger-push']) {
  const turn = { id: `turn_remote_${turnIds.length + 1}`, threadId: conv.id, startedAt: Date.now(), remote: { hostId: host.id } };
  turnIds.push(turn.id);
  // What the runtime keeps on the session for a host turn: its folder on the host. The turn is over (done).
  rt.updateSession(se.id, { remoteTurn: { hostId: host.id, turn: `host-${turn.id}`, rtTurn: turn.id, folder: '/workspace/rec', state: 'done' } });
  rt.ledger.startTurn(turn, { se: store.state.sessions[se.id], folder: null, projectFolder: project.folder ?? null });
  const ledger = rt.ledger;
  const m = createStreamMapper(
    {
      text() {},
      activity() {},
      status() {},
      compaction() {},
      toolUse: (u) => ledger.toolUse(turn, u),
      toolResult: (r) => ledger.toolResult(turn, r),
      taskEnded: (x) => ledger.taskEnded(turn, x),
      usage: (u) => ledger.usage(turn, u),
    },
    { now: () => Date.now() },
  );
  for (const e of await fixture(name)) m.push(e);
  await ledger.endTurn(turn, { status: 'done' });
  await ledger.idle();
}
const work = store.state.work[conv.id];
const edits = work.filter((e) => e.kind === 'edit');
const NOTE = 'Files on host.example.com aren’t recorded: Postbox lists the ones @builder edited there, with no diff and no Restore.';

// ── The page ────────────────────────────────────────────────────────────────────────────

const KEYS = { Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 } };
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
async function press(key) {
  const k = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: 0 };
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const text = (sel) => page.evaluate(`${q(sel)}?.textContent ?? null`);
const count = (sel) => page.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const focusedId = () => page.evaluate('document.activeElement?.id ?? ""');

async function check(name, fn) {
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 60 s')), 60000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
}
async function open(hashTo) {
  await page.evaluate(`location.hash = ${JSON.stringify(hashTo)}`);
  await page.waitFor(`document.querySelector('header.topbar')`);
  await settle();
}
async function axe(where) {
  if (!(await page.evaluate('typeof axe === "object"'))) await page.evaluate(`${AXE};0`);
  const found = await page.evaluate(AXE_RUN);
  assert.deepEqual(found, [], `axe found problems ${where}:\n${found.join('\n')}`);
}
async function noSideways(where) {
  const over = await page.evaluate(`(() => {
    const out = [];
    const d = document.documentElement;
    if (d.scrollWidth > innerWidth + 1) out.push('the page by ' + (d.scrollWidth - innerWidth) + ' px');
    for (const sel of ['.wp-body', '.rpane', '.pane-full']) {
      const el = document.querySelector(sel);
      if (el && el.scrollWidth > el.clientWidth + 1) out.push(sel + ' by ' + (el.scrollWidth - el.clientWidth) + ' px');
    }
    return out;
  })()`);
  assert.deepEqual(over, [], `Scrolls sideways ${where}: ${over.join(', ')}`);
}
/** Whether the page asked the server for a diff since the last call. */
const askedForDiff = () =>
  page.evaluate(
    `(() => { const n = performance.getEntriesByType('resource').some((e) => /\\/work\\/files\\/[^/]+\\/diff/.test(e.name)); performance.clearResourceTimings(); return n; })()`,
  );

const pane = (r = '') => `#/t/${conv.id}${r}`;

await page.goto(`${app.origin}/${pane()}`);
await page.waitFor(`document.querySelector('header.topbar #work-button')`, { label: 'the Work button' });

await check('the ledger kept the host’s edits as steps, with no file to restore', async () => {
  assert.deepEqual([work.filter((e) => e.kind === 'file').length, edits.length], [0, 6]);
  await assert.rejects(rt.restoreWork(conv.id, edits[0].id), (e) => e.status === 409 && /is on host\.example\.com/.test(e.message));
});

for (const [width, height] of [
  [1280, 900],
  [375, 812],
]) {
  const at = `${width} px`;
  await page.size(width, height);
  await open(pane());
  await open(pane('?work'));

  await check(`${at}: the pane says, in one line with the host’s name, that files on the host aren’t recorded`, async () => {
    await page.waitFor(q('#work-pane .work-host-note'), { label: 'the host’s line' });
    assert.equal(await count('#work-pane .work-host-note'), 1, 'one line for one host');
    assert.equal((await text('#work-pane .work-host-note'))?.trim(), NOTE);
    // The files the agent edited, newest first, three at most, each saying where it is.
    const rows = await page.evaluate(`[...document.querySelectorAll('#work-pane [id^="wc-edit-"]')].map((b) => b.textContent)`);
    assert.equal(rows.length, 3);
    for (const r of rows) assert.match(r, /on host\.example\.com, not recorded$/);
    assert.match(await text('#wc-files-h'), /^Files4$/, 'four files: notes.txt, hello.md, untracked.txt and sub.txt');
    assert.equal(await count('#work-pane [id^="restore-"]'), 0);
    assert.doesNotMatch(await text('#work-pane'), /Asking git|No files changed/);
    // Each turn’s line says so too.
    for (const id of turnIds) assert.match(await text(`#wturn-s-${id}`), /files edited on host\.example\.com/);
    await axe('in the pane');
    await noSideways('in the pane');
  });

  await check(`${at}: a turn lists its host’s files, and one opens full screen with no diff and no Restore`, async () => {
    const first = turnIds[0];
    await page.evaluate(`${q(`#wturn-s-${first}`)}.click()`);
    await page.waitFor(q(`#wturn-${first}[open] [id^="wc-t-${first}-we"]`), { label: 'the turn’s files' });
    const edit = edits.find((e) => e.turnId === first && e.rel === 'notes.txt');
    askedForDiff();
    await page.evaluate(`document.getElementById('wc-t-${first}-${edit.id}').focus()`);
    await press('Enter');
    await page.waitFor(`document.querySelector('.pane-full details[open] > summary#wsum-${edit.id}')`, { label: 'notes.txt, opened' });
    assert.equal(await focusedId(), `wsum-${edit.id}`);
    const body = await page.evaluate(`document.querySelector('#wsum-${edit.id}').parentElement.textContent`);
    assert.match(body, /on host\.example\.com, not recorded/);
    assert.match(body, /Postbox didn’t read it, so it has no diff of it and nothing to restore/);
    assert.equal(await count('.pane-full .work-diff, .pane-full [id^="restore-"]'), 0);
    assert.equal(await askedForDiff(), false, 'the page asked for a diff');
    assert.equal(await count('.pane-full .work-host-note'), 1);
    await axe('in one turn, full screen');
    await noSideways('in one turn, full screen');
    await press('Escape');
    await page.waitFor(`!${q('.pane-full')}`, { label: 'full screen to end' });
  });

  await check(`${at}: full screen, the files on the host, and a commit there that doesn’t claim to be pushed`, async () => {
    await page.evaluate(`${q('#work-full')}.click()`);
    await page.waitFor(q('.workpane.pane-full #work-files'), { label: 'Work full screen' });
    assert.equal((await text('.pane-full #work-files .work-host-note'))?.trim(), NOTE);
    // One row per file, however many turns edited it: notes.txt in both.
    const paths = await page.evaluate(`[...document.querySelectorAll('.pane-full #work-files summary .work-path')].map((x) => x.textContent)`);
    assert.deepEqual([...paths].sort(), ['hello.md', 'notes.txt', 'sub.txt', 'untracked.txt']);
    assert.match(await text('#work-files-h'), /^Files4$/);
    assert.equal(await count('.pane-full .work-tile b'), 3, 'the summary’s tiles are still there');
    const vcs = await text('.pane-full #work-vcs');
    assert.match(vcs, /Ledger test on master · @builder on host\.example\.com/);
    assert.doesNotMatch(vcs, /Not pushed|files unknown/);
    assert.match(vcs, /Made branch feature · @builder on host\.example\.com/);
    assert.match(vcs, /Pushed feature to \/workspace\/remote\.git \(feature → feature\) · @builder on host\.example\.com/);
    assert.match(await text('.pane-full #work-commands'), /@builder on host\.example\.com/);
    // The edit opens, still without a diff.
    const notes = edits.find((e) => e.rel === 'notes.txt');
    askedForDiff();
    await page.evaluate(`${q(`#wsum-${notes.id}`)}.click()`);
    await page.waitFor(`document.querySelector('.pane-full details[open] > summary#wsum-${notes.id}')`, { label: 'notes.txt, opened' });
    assert.match(await page.evaluate(`document.querySelector('#wsum-${notes.id}').parentElement.textContent`), /3 edits in 2 turns by @builder/);
    assert.equal(await askedForDiff(), false, 'the page asked for a diff');
    await axe('full screen');
    await noSideways('full screen');
    await press('Escape');
    await page.waitFor(`!${q('.pane-full')}`, { label: 'full screen to end' });
  });
}

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
finish();
