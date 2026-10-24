// A headless Chrome check of going to what an agent needs (#285), driven with real clicks and keys:
// - ⌃J goes to the open conversation’s agent first, then the one that has waited longest, and pressing again visits
//   every agent that needs you, a side thread’s and a refused step’s included.
// - Each jump scrolls the ask into view, focuses it and outlines it, far up a long transcript or in the side panel.
// - Clicking an agent’s needs-you ring or row (the rail, the Agents section, the overview, a message, the top bar)
//   goes to that agent’s ask. In a room’s rail row, a ring goes to its agent and the rest of the row to the oldest.
// - While it needs you, an agent’s ⋯ in the Agents section still opens its quick panel; an idle agent’s row works as before.
//
//   node tools/checks/needs-nav.mjs
//
// It starts its own Postbox on a fresh data folder in the temp directory, with a scripted Claude Code agent (no real
// turns). PB_PORT and PB_CHROME_PORT move it (5360 and 10660 by default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { launch } from '../cdp.mjs';
import { finish, ports, record } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(5360, 10660);

process.env.POSTBOX_BACKENDS = 'mock';
const root = await mkdtemp(join(tmpdir(), 'pb-check-needs-'));
const app = await start({ port: PORT, dataDir: join(root, 'data'), fresh: true, demo: true, quiet: true });
const { rt, store } = app;

const choice = (handle) => ({
  id: `ask-${handle}`,
  type: 'choice',
  version: 1,
  title: `@${handle}: which source first?`,
  fallback: `@${handle}: which source first?`,
  options: [
    { id: 'a', label: 'The papers' },
    { id: 'b', label: 'The notes' },
  ],
});
// Each agent asks once, on its first turn: a choice, or a refused step for @epsilon. Later turns just reply.
const asked = new Set();
rt.adapters.register({
  name: 'claude-code',
  async folderFor() {
    return root;
  },
  async deliver(session, _message, ctx) {
    if (!asked.has(session.handle)) {
      asked.add(session.handle);
      if (session.handle === 'epsilon')
        ctx.denied({ toolUseId: 'tu_eps', tool: 'Bash', input: { command: 'rm -rf build' }, label: 'Run rm -rf build', reason: 'A deny rule.' });
      else if (session.handle !== 'zeta') ctx.tools.show_block({ block: choice(session.handle) });
    }
    ctx.text('Done.');
  },
});
store.emit('project', { id: 'pr_needs', name: 'Needs', folder: root });
const persona = (handle) => rt.createPersona({ handle, backend: 'claude-code', permissionMode: 'auto', tools: [] });
const [alphaP, betaP, gammaP, deltaP, epsilonP, zetaP] = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(persona);
// @beta is in Alpha too, and answers @alpha’s wake in a side thread there.
const alphaT = rt.createThread({ projectId: 'pr_needs', title: 'Alpha', personaIds: [alphaP.id, betaP.id] });
const room = rt.createThread({ projectId: 'pr_needs', title: 'Room', personaIds: [gammaP.id, deltaP.id, zetaP.id] });
const epsT = rt.createThread({ projectId: 'pr_needs', title: 'Refused', personaIds: [epsilonP.id] });
const idle = async () => {
  for (const end = Date.now() + 20000; Date.now() < end && (rt.turns.size || rt.exiting.size); ) await new Promise((r) => setTimeout(r, 30));
};
const sessionOf = (handle) => Object.values(store.state.sessions).find((x) => x.handle === handle && !x.archived);
// The asks, oldest first: @alpha, @gamma, @delta, @beta in a side thread of Alpha, then @epsilon’s refused step.
// A few ms apart, so their order is the order they were made in.
const gap = () => new Promise((r) => setTimeout(r, 15));
rt.sendMessage(alphaT.id, { text: '@alpha where do we start?' });
await idle();
await gap();
rt.sendMessage(room.id, { text: '@gamma where do we start?' });
await idle();
await gap();
rt.sendMessage(room.id, { text: '@delta and you?' });
await idle();
await gap();
rt.agentWake(sessionOf('alpha').id, 'beta', 'Which source should I read first?');
await idle();
await gap();
rt.sendMessage(epsT.id, { text: '@epsilon clean the build.' });
await idle();
// @zeta speaks once and stays idle: its row and ring work as they always did.
rt.sendMessage(room.id, { text: '@zeta anything?' });
await idle();
// A long run of @delta’s notes after the asks, so the room’s asks are far up its transcript.
for (let i = 0; i < 30; i++)
  rt.addItem(room.id, {
    kind: 'agent',
    sessionId: sessionOf('delta').id,
    personaId: deltaP.id,
    handle: 'delta',
    turnId: 'turn_notes',
    text: `Note ${i + 1}. ${'A long line of reading notes that takes up room. '.repeat(6)}`,
    status: 'done',
  });
const S = {};
for (const h of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) S[h] = sessionOf(h);
assert.deepEqual(
  ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((h) => S[h].needs?.kind),
  ['block', 'block', 'block', 'block', 'denial'],
  'every agent but @zeta needs you',
);
const askOf = (h) => S[h].needs.itemId;
const handleOfItem = Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((h) => [askOf(h), h]));

const page = await launch({ port: CHROME_PORT });
const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
/** Clicks the middle of what an expression finds, with the mouse, centered first so the sticky top bar doesn’t cover it. */
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el || !el.getClientRects().length) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing on screen to click: ${expr}`);
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type: t, x: r.x, y: r.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
async function ctrlJ() {
  // From nowhere in particular, so a press that goes nowhere can’t pass for the last one’s landing.
  await page.evaluate('document.activeElement?.blur?.()');
  const base = { key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, nativeVirtualKeyCode: 74, modifiers: 2 };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
/**
 * Closes the quick panel with its Close button. Not with Escape: a key event sent with CDP leaves headless Chrome’s page
 * hidden, and a hidden page draws no frames, so every jump after it would wait for a frame that never comes.
 */
async function closePanel() {
  await click(`document.querySelector('.backdrop .dialog [aria-label="Close"]')`);
  await page.waitFor(`!document.querySelector('.backdrop')`, { label: 'the quick panel to close', timeout: 3000 });
}
async function go(hash) {
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitFor(`location.hash === ${JSON.stringify(hash)} && !!document.querySelector('.topbar')`, { label: hash });
  await settle();
}
/**
 * Where focus is now: the ask (by its agent) it’s inside, whether that ask is on screen, and whether it’s outlined.
 * It waits up to 3 s for focus to land in an ask: a jump may wait for its page to draw.
 */
async function landing() {
  const expr = `(() => {
    const item = document.activeElement?.closest?.('[data-key]');
    if (!item || !${JSON.stringify(Object.keys(handleOfItem))}.includes(item.dataset.key)) return null;
    const b = item.getBoundingClientRect();
    return { key: item.dataset.key, onScreen: b.bottom > 0 && b.top < innerHeight && b.height > 0, outlined: item.classList.contains('arrived'), panel: !!item.closest('.pane, .side-panel, aside') };
  })()`;
  for (const end = Date.now() + 3000; Date.now() < end; ) {
    const r = await page.evaluate(expr);
    if (r) return { ...r, handle: handleOfItem[r.key] };
    await new Promise((res) => setTimeout(res, 50));
  }
  const at = await page.evaluate(`document.activeElement?.closest?.('[data-key]')?.dataset.key ?? document.activeElement?.tagName ?? 'nothing'`);
  return { handle: null, focus: at };
}
const said = (l) => (l.handle ? `@${l.handle}${l.onScreen ? '' : ', off screen'}${l.outlined ? '' : ', not outlined'}` : `no ask (focus on ${l.focus})`);
function landed(l, handle) {
  assert.equal(l.handle, handle, `landed on ${said(l)}, not @${handle}’s ask`);
  assert.ok(l.onScreen, `@${handle}’s ask is focused but off screen`);
  assert.ok(l.outlined, `@${handle}’s ask isn’t outlined on arrival`);
}
async function check(name, fn) {
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 45 s')), 45000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
}

await page.size(1280, 900);
await page.goto(`${app.origin}/#/`);
await page.synced(store.state.seq);
await page.waitFor(`!!document.getElementById('next-needs')`, { label: 'the top bar' });

const ringIn = (scope, h) => `document.querySelector(${JSON.stringify(scope)} + ' pb-ring[data-session="${S[h].id}"]')`;
const agentRow = (h) => `[...document.querySelectorAll('.rail .agent-row')].find((r) => r.querySelector('.agent-btn')?.textContent.includes('@${h}'))`;
const railRow = (t) => `document.querySelector('.rail a.row[data-thread="${t.id}"]')`;

await check('the global button counts every agent that needs you, a refused step’s too', async () => {
  const words = await page.evaluate(`document.getElementById('next-needs').textContent`);
  assert.match(words, /\b5 need you/, `it says “${words.trim()}”`);
});

await check('⌃J visits every agent that needs you, oldest first, each ask on screen, focused and outlined', async () => {
  await go('#/');
  const seen = [];
  for (let i = 0; i < 5; i++) {
    await ctrlJ();
    const l = await landing();
    seen.push(said(l));
  }
  assert.deepEqual(seen, ['@alpha', '@gamma', '@delta', '@beta', '@epsilon']);
});

await check('⌃J from a conversation whose agent needs you goes to that agent first', async () => {
  await go(`#/t/${room.id}`);
  await page.evaluate('scrollTo(0, document.documentElement.scrollHeight)');
  await ctrlJ();
  landed(await landing(), 'gamma');
});

await check('a rail row whose agent needs you goes to its ask', async () => {
  await go(`#/t/${epsT.id}`);
  await click(`${railRow(alphaT)}.querySelector('.name')`);
  landed(await landing(), 'alpha');
});

await check('a room’s rail row: a ring goes to its agent, the rest of the row to the agent that has waited longest', async () => {
  await go(`#/t/${epsT.id}`);
  await click(`${railRow(room)}.querySelector('pb-ring[data-session="${S.delta.id}"]')`);
  landed(await landing(), 'delta');
  await go(`#/t/${epsT.id}`);
  await click(`${railRow(room)}.querySelector('.name')`);
  landed(await landing(), 'gamma');
});

await check('an agent’s row in the Agents section goes to its ask while it needs you', async () => {
  await go(`#/t/${room.id}`);
  await page.evaluate('scrollTo(0, document.documentElement.scrollHeight)');
  await click(`${agentRow('delta')}.querySelector('.agent-btn')`);
  landed(await landing(), 'delta');
  assert.equal(await page.evaluate(`!!document.querySelector('.backdrop .dialog.quick')`), false, 'no quick panel opened');
});

await check('while it needs you, an agent’s ⋯ in the Agents section opens its quick panel', async () => {
  await go(`#/t/${room.id}`);
  await click(`${agentRow('delta')}.querySelector('button[aria-label^="More for @delta"]')`);
  await page.waitFor(`!!document.querySelector('.backdrop .dialog.quick')`, { label: 'the quick panel', timeout: 3000 });
  await closePanel();
});

await check('an idle agent’s row in the Agents section still opens its quick panel', async () => {
  await go(`#/t/${room.id}`);
  assert.equal(await page.evaluate(`!!${agentRow('zeta')}.querySelector('button[aria-label^="More for"]:not([hidden])')`), false, 'no ⋯ while idle');
  await click(`${agentRow('zeta')}.querySelector('.agent-btn')`);
  await page.waitFor(`!!document.querySelector('.backdrop .dialog.quick')`, { label: 'the quick panel', timeout: 3000 });
  await closePanel();
});

await check('an overview card’s ring goes to its ask, in the side panel for a side thread’s agent', async () => {
  await go('#/');
  await click(ringIn('.ov', 'beta'));
  const l = await landing();
  landed(l, 'beta');
  assert.ok(l.panel, '@beta’s ask is in the side panel');
});

await check('the ring beside an agent’s name on a message goes to its ask', async () => {
  await go(`#/t/${room.id}`);
  // @delta’s notes share one sender line, above its ask: scrolled to, as a person would.
  await click(`[...document.querySelectorAll('#main .who pb-ring[data-session="${S.delta.id}"]')].at(-1)`);
  landed(await landing(), 'delta');
});

await check('an agent’s ring in the top bar goes to its ask', async () => {
  await go(`#/t/${room.id}`);
  await click(ringIn('header.topbar', 'gamma'));
  landed(await landing(), 'gamma');
});

const errors = page.logs.filter((l) => l.startsWith('exception'));
record(!errors.length, 'the page threw no exceptions', errors.join('\n'));
await page.close();
await app.close();
await rm(root, { recursive: true, force: true });
finish();
