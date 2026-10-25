// A headless Chrome check of the cards Postbox draws for permissions, driven with real clicks:
// - #237: a card asking for a tool that’s off answers itself when the tool is turned on from the agent’s quick panel,
//   says it’s on, and the agent carries on.
// - #238: a refusal card for a chained command offers no Allow once or Always allow, and says why and what to do; one
//   for a single command still offers both.
// - #220: a permission card nobody answered for CARD_WAIT_MS says it expired and how long it waited.
//
//   node tools/checks/permission-cards.mjs
//
// It starts its own Postbox on a fresh data folder in the temp directory, with a scripted Claude Code agent (no real
// turns). PB_PORT and PB_CHROME_PORT move it (5350 and 10650 by default), so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { expireWait } from '../../server/permission-cards.mjs';
import { launch } from '../cdp.mjs';
import { finish, ports, record } from '../harness.mjs';
import { ALLOW_ONCE_TRIGGERS } from '../uat/allowonce-triggers.mjs';
import { readUi } from '../uat/run-files.mjs';

const { PORT, CHROME_PORT } = await ports(5350, 10650);

process.env.POSTBOX_BACKENDS = 'mock';
const root = await mkdtemp(join(tmpdir(), 'pb-check-cards-'));
const app = await start({ port: PORT, dataDir: join(root, 'data'), fresh: true, demo: true, quiet: true });
const { rt, store } = app;

// A Claude Code agent whose turns this check scripts; a turn with nothing scripted just replies.
const script = [];
const heard = [];
rt.adapters.register({
  name: 'claude-code',
  async folderFor() {
    return root;
  },
  async deliver(_session, message, ctx) {
    heard.push(message);
    const step = script.shift();
    if (step) await step(ctx);
    ctx.text('Done.');
  },
});
store.emit('project', { id: 'pr_cards', name: 'Cards', folder: root });
const persona = rt.createPersona({ handle: 'tester', backend: 'claude-code', permissionMode: 'auto', tools: [] });
const thread = rt.createThread({ projectId: 'pr_cards', title: 'Cards check', personaIds: [persona.id] });
const se = rt.sessionsIn(thread.id)[0];

const page = await launch({ port: CHROME_PORT });

const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type: t, x: r.x, y: r.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
const text = (expr) => page.evaluate(`(${expr})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((n) => n.textContent.includes(${JSON.stringify(text)}))`;
// A time budget, not a count of tries: with other checks running beside it, a count runs out (#162).
const until = async (fn, label, timeout = 15000) => {
  for (const end = Date.now() + timeout; Date.now() < end; ) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
async function check(name, fn) {
  let timer;
  try {
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
}

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${thread.id}`);
await page.waitFor(`!!document.getElementById('composer-input')`, { label: 'the composer' });

await check('#237 Shell turned on from the quick panel answers the card that asked for it, and the agent carries on', async () => {
  script.push(async (ctx) => {
    ctx.tools.ask_for_tool({ tool: 'shell', why: 'To run the tests.' });
  });
  rt.sendMessage(thread.id, { text: 'Run the tests.' });
  const ask = byText('.transcript .block', 'asks you to turn on “Run commands');
  await page.waitFor(`!!(${ask})?.querySelector('.block-foot')`, { label: 'the card' });
  await until(() => rt.turns.size === 0 && store.state.sessions[se.id].needs?.kind === 'toolask', 'the agent to need you');
  await page.synced(store.state.seq);
  const turns = heard.length;
  // Its name in the sidebar opens its quick panel, needing you or not (#320), where Shell is a switch for the persona.
  await click(`[...document.querySelectorAll('.rail .agent-row .agent-btn')].find((b) => b.querySelector('b')?.textContent === '@tester')`);
  const panel = `document.querySelector('.backdrop .dialog.quick')`;
  await page.waitFor(`!!${panel}?.querySelector('[role=switch][aria-label^="Shell"]')`, { label: 'the quick panel' });
  await click(`${panel}.querySelector('[role=switch][aria-label^="Shell"]')`);
  await page.waitFor(`/Turned on\\./.test((${ask})?.innerText ?? '')`, { label: 'the card answered' });
  // textContent: the label is drawn in capitals.
  assert.equal(await page.evaluate(`${ask}.querySelector('.kind').textContent`), 'Turned on · shell');
  assert.equal(await page.evaluate(`!!(${ask}).querySelector('.block-foot')`), false, 'no button is left to press');
  assert.ok(store.state.personas[persona.id].tools.includes('shell'), 'the persona has Shell');
  await until(() => heard.length > turns && rt.turns.size === 0, 'the agent’s next turn');
  assert.equal(heard.at(-1).kind, 'notice');
  assert.match(heard.at(-1).text, /turned on shell/);
  assert.equal(store.state.sessions[se.id].needs, null, 'it no longer needs you');
});

await check('#238 a refused chained command offers no Allow once or Always allow, and says why; a single command still does', async () => {
  const refuse = (command, label) =>
    script.push(async (ctx) => {
      ctx.denied({ toolUseId: `tu-${label}`, tool: 'Bash', input: { command }, label, reason: '[Data Exfiltration]', reasonType: 'classifier' });
    });
  refuse('cd src && python -m pytest -q 2>&1 | tail -20', 'Run the chained tests');
  refuse('python -m pytest -q', 'Run the single tests');
  rt.sendMessage(thread.id, { text: 'Run the tests twice.' });
  rt.sendMessage(thread.id, { text: 'And again.' });
  const chained = byText('.transcript .block', 'tried to run the chained tests');
  const single = byText('.transcript .block', 'tried to run the single tests');
  await page.waitFor(`!!(${chained})?.querySelector('.block-foot') && !!(${single})?.querySelector('.block-foot')`, { label: 'both cards' });
  await until(() => rt.turns.size === 0, 'the turns to end');
  await page.synced(store.state.seq);
  const buttons = (card) => page.evaluate(`[...(${card}).querySelectorAll('.block-foot button')].map((b) => b.textContent)`);
  assert.deepEqual(await buttons(chained), ['Leave it']);
  assert.match(
    await text(`${chained}.querySelector('.block-body')`),
    /Claude Code checks each part of a chained command \(joined by &&, \|\|, ;, \| or &, or inside \$\( \)\) against its rules on its own/,
  );
  assert.match(await text(`${chained}.querySelector('.block-body')`), /ask @tester to run the parts as separate commands/);
  assert.deepEqual(await buttons(single), ['Allow once and retry', 'Always allow commands that start with “python -m”', 'Leave it']);
  // The UAT runner reads these cards from the page the same way, for the allow-once scenario’s trigger (readUi).
  const facts = { threads: [thread.id], state: rt.s, ui: { denialCards: (await readUi(page)).denialCards } };
  assert.equal(ALLOW_ONCE_TRIGGERS['chained-refusal-no-allow'].run(facts).length, 1, 'the trigger sees the chained card only');
});

await check('#220 a permission card nobody answered for 25 hours says it expired, and how long it waited', async () => {
  const answers = [];
  script.push(async (ctx) => {
    answers.push(await ctx.askPermission({ tool: 'Bash', summary: 'run the slow tests', input: { command: 'npm run slow' } }));
  });
  rt.sendMessage(thread.id, { text: 'Run the slow tests.' });
  const ask = byText('.transcript .block', 'run the slow tests?');
  await page.waitFor(`!!(${ask})?.querySelector('.block-foot')`, { label: 'the card' });
  const card = store.items(thread.id).find((i) => i.kind === 'permission' && i.status === 'open');
  // What the card’s timer does at CARD_WAIT_MS; the server’s tests run that timer on an injected clock.
  expireWait(rt, card.id);
  await page.waitFor(`/Expired/.test((${ask})?.innerText ?? '')`, { label: 'the expired card' });
  assert.equal(await text(`${ask}.querySelector('.answered-note')`), 'Expired: nobody answered within 25 hours');
  assert.equal(await page.evaluate(`!!(${ask}).querySelector('.block-foot')`), false, 'nothing is left to answer');
  await until(() => answers.length && rt.turns.size === 0, 'the answer to reach the agent');
  assert.equal(answers[0].allow, false);
});

const errors = page.logs.filter((l) => l.startsWith('exception'));
record(!errors.length, 'the page threw no exceptions', errors.join('\n'));
await page.close();
await app.close();
await rm(root, { recursive: true, force: true });
finish();
