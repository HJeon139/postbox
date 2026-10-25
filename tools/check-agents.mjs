// A headless Chrome check of the agents section and each agent’s quick panel (#105), driven with real key presses
// and clicks, at 1280 and 375 px: the rows in the sidebar, and a topic thread’s line of who is in it (#228); changing
// the model, effort, permission mode and shell in two clicks; the scope each control says; the links, Stop, Compact
// and Archive; the rings in the top bar, which open the same panel where the sidebar is hidden; and the subagents at
// work in the tree and the working row, from a recorded stream (#73), with End on each, by keyboard (#229).
//
//   node tools/check-agents.mjs
//
// It starts its own server with the demo seed on a fresh data folder in the temp directory, with a Claude home of its
// own there, and moves @indexer and @researcher to Claude Code and the Agent SDK. Those backends are fakes that only
// record what they’re sent, so no real agent runs. PB_PORT and PB_CHROME_PORT move it, so sessions working in
// parallel don’t collide; ONLY=<text> runs only the cases whose names include it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { start } from '../server/index.mjs';
import { js, launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4870, 9870);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-agents-'));
const claudeHome = await mkdtemp(join(tmpdir(), 'pb-check-agents-home-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;
// What the real backends were sent: a turn each, recorded, never run. A turn can instead replay a recorded stream
// through the real stream mapper (`replays`), as far as its `pause` and then the rest once `go` is called.
const turns = [];
/** @type {{ lines: any[], pause: number, go: () => void, wait: Promise<void>, held: boolean }[]} */
const replays = [];
for (const name of ['claude-code', 'agent-sdk'])
  rt.adapters.register({
    name,
    async folderFor() {
      return dataDir;
    },
    async deliver(session, message, ctx) {
      turns.push({ handle: session.handle, text: message.text });
      const r = replays.shift();
      if (!r) return ctx.text('Done.');
      const m = createStreamMapper(ctx);
      for (const e of r.lines.slice(0, r.pause)) m.push(e);
      r.held = true;
      await r.wait;
      for (const e of r.lines.slice(r.pause)) m.push(e);
    },
  });
/** A recorded stream to replay on the next turn, held after its line `pause` until `go()`. */
function replayNext(name, pauseWhen) {
  const lines = readFileSync(new URL(`../tests/fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  let go = () => {};
  const wait = new Promise((r) => {
    go = () => r(undefined);
  });
  const r = { lines, pause: lines.findIndex(pauseWhen) + 1, go, wait, held: false };
  replays.push(r);
  return r;
}

// ── The agents ──────────────────────────────────────────────────────────────────────────

const personaNamed = (handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
// Real backends aren’t registered here (POSTBOX_BACKENDS=mock), so the personas are moved in the store, as an edit
// in the persona sheet would on a computer with Claude Code.
const real = (handle, patch) => store.emit('persona', { ...personaNamed(handle), ...patch, version: (personaNamed(handle).version ?? 1) + 1 });
const threadNamed = (title) => Object.values(store.state.threads).find((t) => t.title === title);
const planning = threadNamed('Corpus planning');
const shelf = threadNamed('Index the shelf');
const sessionIn = (t, handle) => rt.sessionsIn(t.id).find((x) => x.handle === handle);
const indexer = sessionIn(planning, 'indexer');
// A topic thread from a reply of @indexer’s, answered there by its one session in the conversation (#228).
const root = rt.addItem(planning.id, {
  kind: 'agent',
  sessionId: indexer.id,
  personaId: indexer.personaId,
  handle: 'indexer',
  text: 'The shelf has 40 books.',
  status: 'done',
});
const topic = store.state.threads[rt.startTopic(planning.id, root.id).threadId];
real('indexer', { backend: 'claude-code', model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'auto' });
real('researcher', { backend: 'agent-sdk', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'auto' });

// ── Real input ──────────────────────────────────────────────────────────────────────────

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};
/** Presses a key the way a keyboard does: keydown (with its text), then keyup. */
async function press(key, { shift = false } = {}) {
  const k = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: shift ? 8 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await settle();
}
/** Clicks the middle of the element an expression finds, with the mouse. */
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el || !el.offsetWidth) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing on screen to click: ${expr}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
// Headless Chrome can hold back animation frames while nothing on screen changes, so wait on a timer too.
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
/** Puts focus on an element, as Tab would, before the key presses that test it. */
const focus = async (expr) => {
  assert.ok(await page.evaluate(`(() => { const el = ${expr}; el?.focus(); return !!el && document.activeElement === el; })()`), `Couldn’t focus: ${expr}`);
};
/** The focused element’s role or tag, and its accessible name (its label, else its text). */
const focused = () =>
  page.evaluate(
    `(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; return (a.getAttribute('role') ?? a.tagName.toLowerCase()) + ': ' + (a.getAttribute('aria-label') ?? a.textContent.trim().replace(/\\s+/g, ' ')).slice(0, 80); })()`,
  );
/** Waits for something on the server’s side, such as a turn the fake backend was sent. */
async function until(test, label) {
  for (let i = 0; i < 50; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
/** The focused element’s accessible name, as Chrome computes it for a screen reader. */
async function axName() {
  const { result } = await page.send('Runtime.evaluate', { expression: 'document.activeElement' });
  const { nodes } = await page.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false });
  return nodes[0]?.name?.value ?? '';
}
const q = (sel) => `document.querySelector(${js(sel)})`;
/** An agent’s row: in the sidebar, or in the open topic thread’s panel. */
const row = (handle, where = '.rail') =>
  `[...document.querySelectorAll('${where} .agent-row .agent-btn')].find((b) => b.querySelector('b')?.textContent === '@${handle}')`;
const panel = `document.querySelector('.backdrop .dialog.quick')`;
const inPanel = (sel, text) => `[...(${panel}?.querySelectorAll(${js(sel)}) ?? [])].find((n) => n.textContent.trim().startsWith(${js(text)}))`;
const radio = (group, name) => `${panel}?.querySelector('[role=radiogroup][aria-label^="${group}"]') && ${inPanel('[role=radio]', name)}`;
const checked = (group) => page.evaluate(`${panel}?.querySelector('[role=radiogroup][aria-label^="${group}"] [aria-checked="true"]')?.textContent`);

async function check(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  let timer;
  try {
    // One case that hangs mustn’t block the rest.
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 30 s')), 30000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
  // Each case starts from a clean page: Escape closes any panel or menu left open, the way a person would.
  for (let i = 0; i < 4 && (await page.evaluate(`!!document.querySelector('.backdrop, .menu')`)); i++) await press('Escape');
}
let loaded = false;
/** Opens a view: the first time by loading the page, then by changing the hash, as the app’s links do. */
async function open(hash) {
  if (loaded) {
    // What the check changed on the server must have reached the page first, or it shows what was there before.
    await page.synced(store.state.seq);
    await page.evaluate(`location.hash = ${js(hash)}`);
  } else await page.goto(`${app.origin}/${hash}`);
  loaded = true;
  await page.waitFor(`document.querySelector('header.topbar')`);
  await settle();
}
/** Whether the open panel is on screen whole, and the page doesn’t scroll sideways. */
const panelFits = () =>
  page.evaluate(
    `(() => { const b = ${panel}.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && document.documentElement.scrollWidth <= innerWidth; })()`,
  );

await page.size(1280, 900);

// ── The sidebar’s Agents section ────────────────────────────────────────────────────────

await check('a conversation’s agents are a section in the sidebar, above Direct messages, one row each', async () => {
  await open(`#/t/${planning.id}`);
  const order = await page.evaluate(
    `[...document.querySelectorAll('.rail .label')].map((l) => l.textContent).filter((t) => ['Agents', 'Direct messages', 'Rooms'].includes(t))`,
  );
  assert.deepEqual(order, ['Agents', 'Direct messages', 'Rooms']);
  const rows = await page.evaluate(`[...document.querySelectorAll('.rail .agent-row .agent-btn')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], '@indexer · idle Opus 5.5 · medium effort');
  assert.match(rows[1], /^@researcher · idle Opus 5\.5 · \w+ effort$/);
  // The list is named by its heading, and each row says it opens a dialog.
  assert.equal(await page.evaluate(`document.getElementById(${q('.rail .agent-rows')}.getAttribute('aria-labelledby')).textContent`), 'Agents');
  assert.equal(await page.evaluate(`${row('indexer')}.getAttribute('aria-haspopup')`), 'dialog');
});

await check('Enter on a row opens its quick panel, labeled with the agent, with focus on its model', async () => {
  await open(`#/t/${planning.id}`);
  await focus(row('indexer'));
  await press('Enter');
  await page.waitFor(panel, { label: 'the quick panel' });
  assert.equal(await page.evaluate(`${panel}.getAttribute('role')`), 'dialog');
  assert.equal(await page.evaluate(`document.getElementById(${panel}.getAttribute('aria-labelledby')).textContent`), '@indexer');
  assert.equal(await page.evaluate(`${row('indexer')}.getAttribute('aria-expanded')`), 'true');
  assert.equal(await focused(), 'radio: Opus 5.5');
  assert.ok(await panelFits(), 'The panel isn’t on screen whole');
  // Beside the row, not over it.
  assert.ok(await page.evaluate(`${panel}.getBoundingClientRect().left >= ${row('indexer')}.getBoundingClientRect().right`), 'The panel covers its row');
});

await check('every control says whether it’s for this conversation or for the persona everywhere', async () => {
  await open(`#/t/${planning.id}`);
  await click(row('indexer'));
  await page.waitFor(panel);
  const heads = await page.evaluate(`[...${panel}.querySelectorAll('.qp-head')].map((x) => x.textContent)`);
  assert.deepEqual(heads, ['In this conversation', 'For @indexer everywhere']);
  // Each control’s own name carries its scope, so it’s heard on the control too.
  const names = await page.evaluate(`[...${panel}.querySelectorAll('[role=radiogroup], [role=switch]')].map((x) => x.getAttribute('aria-label'))`);
  assert.deepEqual(names, [
    'Model, in this conversation',
    'Effort, in this conversation',
    'Permission mode, in every conversation @indexer is in',
    'Shell, for @indexer everywhere',
    'Web, for @indexer everywhere',
    'Agents outside Postbox, for @indexer everywhere',
  ]);
  // Each switch says what turning it off means (#104).
  const help = await page.evaluate(
    `[...${panel}.querySelectorAll('[role=switch]')].map((s) => document.getElementById(s.getAttribute('aria-describedby'))?.textContent)`,
  );
  assert.deepEqual(help, [
    'Off: it can’t run commands. It can still read and search files.',
    'Off: it can’t fetch pages or search the web.',
    'Off: it can’t message, schedule or start agents outside Postbox.',
  ]);
});

// ── Two clicks, without a command ───────────────────────────────────────────────────────

await check('from the sidebar, two clicks change the model, for this conversation only', async () => {
  await open(`#/t/${planning.id}`);
  // The row, then Sonnet 5.5.
  await click(row('indexer'));
  await click(radio('Model', 'Sonnet 5.5'));
  await page.waitFor(`${q('.qp .perm-status')}?.textContent.includes('Sonnet 5.5')`, { label: 'the status line' });
  // The panel says it as soon as the server answers; what follows reads the change the server sends after.
  await page.synced(store.state.seq);
  await settle();
  assert.equal(store.state.sessions[indexer.id].personaSnapshot.model, 'claude-sonnet-5-5');
  assert.equal(personaNamed('indexer').model, 'claude-opus-5-5', 'The persona’s model changed too');
  assert.equal(await page.evaluate(`${q('.qp .perm-status')}.textContent`), 'Model: Sonnet 5.5 for @indexer in this conversation, from its next turn.');
  assert.equal(await checked('Model'), 'Sonnet 5.5');
  await press('Escape');
  // The row says the new setting at once.
  await page.waitFor(`${row('indexer')}.innerText.includes('Sonnet 5.5')`, { label: 'the row to say Sonnet 5.5' });
});

await check('from the sidebar, two clicks change the effort', async () => {
  await open(`#/t/${planning.id}`);
  await click(row('indexer'));
  await click(radio('Effort', 'High'));
  await page.waitFor(`${q('.qp .perm-status')}?.textContent.includes('Effort: high')`);
  assert.equal(store.state.sessions[indexer.id].personaSnapshot.effort, 'high');
});

await check('from the sidebar, two clicks change the permission mode, for the persona everywhere', async () => {
  await open(`#/t/${planning.id}`);
  await click(row('indexer'));
  await click(radio('Permission mode', 'Ask me'));
  await page.waitFor(`${q('.qp .perm-status')}?.textContent.includes('Ask me')`);
  assert.equal(personaNamed('indexer').permissionMode, 'ask');
  assert.match(await page.evaluate(`${q('.qp .perm-status')}.textContent`), /in every conversation/);
});

await check('from the sidebar, two clicks turn the shell off, for the persona everywhere', async () => {
  await open(`#/t/${planning.id}`);
  assert.ok(personaNamed('indexer').tools.includes('shell'));
  await click(row('indexer'));
  await click(`${panel}.querySelector('[role=switch][aria-label^="Shell"]')`);
  await page.waitFor(`${panel}.querySelector('[role=switch][aria-label^="Shell"]').getAttribute('aria-checked') === 'false'`, {
    label: 'the switch to turn off',
  });
  assert.ok(!personaNamed('indexer').tools.includes('shell'));
  assert.equal(await page.evaluate(`${q('.qp .perm-status')}.textContent`), 'Shell: off for @indexer in every conversation, from their next turns.');
  // The switch says “Off” in words, not only by its look.
  assert.match(await page.evaluate(`${panel}.querySelector('[role=switch][aria-label^="Shell"]').innerText`), /Off/);
});

await check('by keyboard: Tab moves through the panel, Space switches, and Escape returns focus to the row', async () => {
  await open(`#/t/${planning.id}`);
  await focus(row('indexer'));
  await press('Enter');
  await page.waitFor(panel);
  // One Tab stop per group: the model, the effort, the mode, then the shell switch.
  await press('Tab');
  assert.equal(await focused(), 'radio: High');
  await press('Tab');
  assert.equal(await focused(), 'radio: Ask me');
  // Arrow keys move within a group without picking.
  await press('ArrowDown');
  assert.equal(await focused(), 'radio: Accept edits');
  assert.equal(personaNamed('indexer').permissionMode, 'ask');
  const seenNames = [];
  for (let i = 0; i < 12 && !(await focused()).startsWith('switch: Shell'); i++) {
    await press('Tab');
    seenNames.push(await focused());
  }
  assert.equal(await focused(), 'switch: Shell, for @indexer everywhere', `Tab went: ${seenNames.join(' › ')}`);
  await press(' ');
  await page.waitFor(`${panel}?.querySelector('[role=switch][aria-label^="Shell"]')?.getAttribute('aria-checked') === 'true'`, {
    label: 'Space to turn the shell back on',
  });
  assert.ok(personaNamed('indexer').tools.includes('shell'));
  // Focus stays on the switch after the panel repaints.
  assert.equal(await focused(), 'switch: Shell, for @indexer everywhere');
  await press('Escape');
  assert.equal(await page.evaluate(`!!${panel}`), false);
  // The row’s name is its words: the ring beside them is hidden from screen readers, so it isn’t read twice.
  assert.equal(await axName(), '@indexer · idle Sonnet 5.5 · high effort');
  assert.equal(await page.evaluate(`${row('indexer')}.getAttribute('aria-expanded')`), 'false');
});

await check('a change made elsewhere reaches the open panel', async () => {
  await open(`#/t/${planning.id}`);
  await click(row('indexer'));
  await rt.setSessionRun(indexer.id, { model: 'claude-haiku-5-5' });
  await page.waitFor(`${panel}?.querySelector('[role=radiogroup][aria-label^="Model"] [aria-checked="true"]')?.textContent === 'Haiku 5.5'`, {
    label: 'the panel to show Haiku 5.5',
  });
});

// ── Links and actions ───────────────────────────────────────────────────────────────────

await check('“Rules, folders and MCP…” opens the permissions panel on the agent; Escape returns to its row', async () => {
  await open(`#/t/${planning.id}`);
  await focus(row('indexer'));
  await press('Enter');
  await page.waitFor(panel);
  await focus(inPanel('button', 'Rules, folders and MCP…'));
  await press('Enter');
  await page.waitFor(`!${panel} && document.querySelector('.backdrop .dialog')`, { label: 'the permissions panel' });
  assert.match(await page.evaluate(`document.querySelector('.backdrop .dialog').textContent`), /@indexer/);
  await press('Escape');
  assert.match(await focused(), /^button: @indexer/);
});

await check('“Edit persona…” opens Settings › Personas on the agent', async () => {
  await open(`#/t/${planning.id}`);
  await click(row('researcher'));
  await click(inPanel('button', 'Edit persona…'));
  await page.waitFor(`document.querySelector('.backdrop .dialog [role=tab][aria-selected=true]')?.textContent === 'Personas'`, {
    label: 'Settings › Personas',
  });
  assert.match(await page.evaluate(`document.querySelector('.backdrop .dialog').innerText`), /@researcher/);
});

await check('Stop is there only while it works, Compact only on a real backend, and a mock agent has no model to change', async () => {
  await open(`#/t/${planning.id}`);
  await click(row('indexer'));
  assert.equal(await page.evaluate(`${inPanel('button', 'Stop')}.disabled`), true);
  assert.equal(await page.evaluate(`${inPanel('button', 'Compact')}.disabled`), false);
  rt.updateSession(indexer.id, { state: 'tool' });
  await page.waitFor(`${inPanel('button', 'Stop')}?.disabled === false`, { label: 'Stop to turn on while it works' });
  assert.equal(await page.evaluate(`${inPanel('button', 'Compact')}.disabled`), true);
  await click(inPanel('button', 'Stop'));
  await page.waitFor(`${q('.qp .perm-status')}?.textContent === 'Stopping @indexer.'`, { label: 'the Stop status' });
  // While its process exits it reads “stopping” (#126), in the panel and its row, and Stop isn’t offered again.
  rt.updateSession(indexer.id, { state: 'stopping' });
  await page.waitFor(`${inPanel('button', 'Stop')}?.disabled === true && ${row('indexer')}.innerText.includes('· stopping')`, {
    label: 'Stop to turn off while it stops',
  });
  assert.match(await page.evaluate(`document.getElementById(${panel}.getAttribute('aria-labelledby')).closest('.d-head').innerText`), /Stopping/);
  rt.updateSession(indexer.id, { state: 'idle' });
  // Compact runs Claude Code’s /compact as the agent’s turn, as the composer’s /compact does, and closes the panel.
  await page.waitFor(`${inPanel('button', 'Compact')}?.disabled === false`);
  await click(inPanel('button', 'Compact'));
  await page.waitFor(`!${panel}`, { label: 'the panel to close' });
  await until(() => turns.some((x) => x.handle === 'indexer' && x.text === '/compact'), 'the /compact turn');
  // A mock agent: no model, effort or mode; its tools still show, on its persona.
  const dm = threadNamed('Corpus schema spec');
  await open(`#/t/${dm.id}`);
  await click(row('critic'));
  const text = await page.evaluate(`${panel}.innerText`);
  assert.match(text, /A mock agent runs scripted replies, so it has no model, effort or permission mode to change\./);
  assert.equal(await page.evaluate(`!!${panel}.querySelector('[role=radiogroup]')`), false);
  assert.equal(await page.evaluate(`!!${inPanel('button', 'Compact')}`), false);
  assert.equal(await page.evaluate(`${panel}.querySelectorAll('[role=switch]').length`), 3);
});

await check('Delete session… in the panel opens its confirmation, and there’s no Archive (#320)', async () => {
  await open(`#/t/${shelf.id}`);
  await click(row('indexer'));
  assert.equal(await page.evaluate(`!!${inPanel('button', 'Archive')}`), false, 'The panel still offers Archive');
  await click(inPanel('button', 'Delete session'));
  await page.waitFor(`[...document.querySelectorAll('.dialog')].some((d) => d.textContent.includes('Delete @indexer’s session?'))`, {
    label: 'the confirmation',
  });
  await press('Escape');
  assert.equal(store.state.sessions[sessionIn(shelf, 'indexer').id].deleting ?? false, false, 'Escape deleted it');
});

// ── A topic thread ──────────────────────────────────────────────────────────────────────

await check('a topic thread is answered by the conversation’s own session; its panel names it in a line, with no list (#228)', async () => {
  await open(`#/t/${planning.id}/side/${topic.id}`);
  await page.waitFor(`${q('.sp-agents p')}?.textContent === '@indexer is in this thread.'`, { label: 'the line' });
  assert.equal(await page.evaluate(`document.querySelectorAll('.sidepanel .agent-row, .sidepanel .agents-sec').length`), 0, 'The thread lists agents');
  const n = turns.length;
  rt.sendMessage(topic.id, { text: 'Which shelf?' });
  await until(() => turns.length > n, 'the reply');
  assert.deepEqual(turns.at(-1), { handle: 'indexer', text: 'Which shelf?' });
  assert.equal(rt.sessionsIn(topic.id).length, 0, 'The thread has a session of its own');
  await until(() => store.state.sessions[indexer.id].state === 'idle', 'the turn to end');
  await page.synced(store.state.seq);
  assert.equal(await page.evaluate(`document.querySelectorAll('.rail .agent-row').length`), rt.sessionsIn(planning.id).length, 'A row that isn’t an agent');
});

// ── The top bar’s rings, and a narrow window ────────────────────────────────────────────

// ── Subagents (#73) ─────────────────────────────────────────────────────────────────────

await check('a subagent at work is a child in the agent tree, with what it was asked and what it’s doing now, without hover', async () => {
  // Recorded: tests/fixtures/claude-code/subagent-tree.jsonl, held once the Reader has started its own subagent.
  const NESTED = 'toolu_014cQVtisPCNL6gRibMij5jM';
  const r = replayNext('subagent-tree', (e) => e.type === 'user' && e.message?.content?.some?.((b) => b.tool_use_id === NESTED));
  await open(`#/t/${planning.id}`);
  try {
    rt.sendMessage(planning.id, { text: '@indexer count the words, with a subagent' });
    const subs = `${row('indexer')}.closest('.agent-row').querySelectorAll('.agent-sub.subagent')`;
    await until(() => r.held, 'the replay to reach its pause');
    await page.synced(store.state.seq);
    const shown = await page.evaluate(
      `[...${subs}].map((li) => ({ depth: li.dataset.depth, head: li.querySelector('.sub-head').innerText, now: li.querySelector('.sub-now').innerText, w: li.querySelector('.sub-now').offsetWidth, title: li.querySelector('[title]')?.title ?? null }))`,
    );
    // The Reader, then the subagent it started, nested under it; each with what it was asked and, on a line of its own,
    // what it’s doing now: the Reader’s latest narration in its own words, then its step since.
    assert.deepEqual(
      shown.map((x) => [x.depth, x.head]),
      [
        ['0', 'general-purpose · subagent: Reader'],
        ['1', 'general-purpose · subagent in the background: Nested checker'],
      ],
    );
    // Its step changed after it spoke, so the line says both.
    assert.equal(shown[0].now, '“The word count came back as 3.” · Subagent: Nested checker');
    assert.equal(shown[1].now, 'Nested checker');
    // On screen, not in a tooltip.
    assert.ok(
      shown.every((x) => x.w > 0 && x.title === null),
      JSON.stringify(shown),
    );
    // The working row says it too, attributed.
    assert.match(await page.evaluate(`${q('.working .work-row')}?.innerText ?? ''`), /general-purpose: “The word count came back as 3\.”/);
    r.go();
    // The turn ends: its subagents leave the tree, and its activity list nests each subagent’s steps under it.
    await until(() => store.state.sessions[indexer.id].state === 'idle', 'the turn to end');
    await page.synced(store.state.seq);
    assert.equal(await page.evaluate(`${subs}.length`), 0, 'The subagents are still in the tree');
    const reply = `[...document.querySelectorAll('.turn details.activity')].at(-1)`;
    const tree = await page.evaluate(
      `(() => { const top = ${reply}.querySelector(':scope > ul.steps'); const reader = [...top.children].find((li) => li.querySelector(':scope > .step-text')?.textContent.includes('Subagent: Reader')); return { said: [...reader.querySelectorAll(':scope > ul.steps > li.said')].map((li) => li.querySelector('.step-text > summary, .step-text').textContent), nested: !!reader.querySelector(':scope > ul.steps > li > ul.steps li.said') }; })()`,
    );
    assert.equal(tree.said[0], "general-purpose: I'll count the words in the test string with Bash to get the first result.");
    assert.ok(tree.nested, 'The nested subagent’s narration isn’t nested under it');
  } finally {
    r.go();
  }
});

await check('End on a subagent’s row, by keyboard, tells its agent and reads “ending”; focus moves to the next row (#229)', async () => {
  const NESTED = 'toolu_014cQVtisPCNL6gRibMij5jM';
  const r = replayNext('subagent-tree', (e) => e.type === 'user' && e.message?.content?.some?.((b) => b.tool_use_id === NESTED));
  await open(`#/t/${planning.id}`);
  try {
    rt.sendMessage(planning.id, { text: '@indexer count the words, with a subagent' });
    await until(() => r.held, 'the replay to reach its pause');
    await page.synced(store.state.seq);
    const ends = `[...${row('indexer')}.closest('.agent-row').querySelectorAll('.agent-sub.subagent .sub-end')]`;
    await page.waitFor(`${ends}.length === 2`, { label: 'End on each subagent' });
    assert.equal(await page.evaluate(`${ends}[0].getAttribute('aria-label')`), 'End @indexer’s subagent ‘Reader’');
    const first = store.state.sessions[indexer.id].subagents[0].id;
    await focus(`${ends}[0]`);
    await press('Enter');
    await until(() => (store.state.sessions[indexer.id].endingSubagents ?? []).includes(first), 'the subagent to be ending');
    assert.ok(store.state.sessions[indexer.id].context.some((x) => x.startsWith('[Postbox] URGENT: the person ended your subagent')));
    await page.waitFor(`document.activeElement?.getAttribute('aria-label') === 'End @indexer’s subagent ‘Nested checker’'`, { label: 'focus on the next End' });
    await page.synced(store.state.seq);
    await page.waitFor(
      `${row('indexer')}.closest('.agent-row').querySelector('.agent-sub.subagent .sub-now').textContent === 'Ending: @indexer was told to stop it'`,
      {
        label: 'the row to read ending',
      },
    );
  } finally {
    r.go();
  }
  await until(() => store.state.sessions[indexer.id].state === 'idle', 'the turn to end');
});

for (const theme of ['light', 'dark'])
  await check(`at 375 px (${theme}), the top bar fits a long title with no agent rings, and its menu names each agent (#320)`, async () => {
    await page.size(375, 812, { theme });
    try {
      rt.renameThread(shelf.id, 'Index every book on the shelf, then check the index against the catalog');
      await open(`#/t/${shelf.id}`);
      assert.equal(
        await page.evaluate(`document.querySelector('header.topbar').scrollWidth <= document.querySelector('header.topbar').clientWidth`),
        true,
        'The top bar overflows',
      );
      assert.equal(await page.evaluate(`document.querySelectorAll('header.topbar pb-ring').length`), 0, 'The top bar has agent rings');
      // Where the sidebar is hidden, the conversation’s menu names its agents, each leading to its persona.
      await click(`document.querySelector('header.topbar #conversation-actions')`);
      await page.waitFor(`document.querySelector('.menu')`);
      assert.ok(
        await page.evaluate(`[...document.querySelectorAll('.menu button.mi')].some((b) => b.innerText.includes('@indexer'))`),
        'The menu doesn’t name @indexer',
      );
      await press('Escape');
    } finally {
      rt.renameThread(shelf.id, 'Index the shelf');
      await page.size(1280, 900);
    }
  });

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
await rm(claudeHome, { recursive: true, force: true });
record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
finish();
