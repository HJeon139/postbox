// The cards Postbox draws for permissions, driven with real clicks:
// - #237: a card asking for a tool that’s off answers itself when the tool is turned on from the agent’s quick panel,
//   says it’s on, and the agent carries on.
// - #238: a refusal card for a chained command offers no Allow once or Always allow, and says why and what to do; one
//   for a single command still offers both.
// - #281: one for a command with a * offers neither, and says a * is a wildcard; one for env or bash -c offers only
//   its exact text, never Bash(env:*).
// - #220: a permission card nobody answered for CARD_WAIT_MS says it expired and how long it waited.
// With a scripted Claude Code agent (no real turns), a persona and conversation of its own for each test. Moved from
// tools/checks/permission-cards.mjs (#303).

import { expect, test } from '@playwright/test';
import { expireWait } from '../../server/permission-cards.mjs';
import { ALLOW_ONCE_TRIGGERS } from '../../tools/uat/allowonce-triggers.mjs';
import { readUi } from '../../tools/uat/run-files.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What the agent’s next turns do, by session; a turn with nothing scripted just replies. And what it heard. */
const scripts = new Map();
const heard = [];
test.beforeAll(async () => {
  app = await startPostbox('permission-cards');
  const { rt, store } = app;
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(session, message, ctx) {
      heard.push({ ...message, sessionId: session.id });
      const step = scripts.get(session.id)?.shift();
      if (step) await step(ctx);
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_cards', name: 'Cards', folder: app.root });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A persona of its own on Claude Code, with no tools, in a conversation of its own, open in the page. */
async function agent(page, handle) {
  const { rt } = app;
  const persona = rt.createPersona({ handle, backend: 'claude-code', permissionMode: 'auto', tools: [] });
  const thread = rt.createThread({ projectId: 'pr_cards', title: `Cards for @${handle}`, personaIds: [persona.id] });
  const se = rt.sessionsIn(thread.id)[0];
  scripts.set(se.id, []);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const idle = () => expect.poll(() => rt.turns.has(se.id), { message: 'the agent’s turn to end' }).toBe(false);
  return { persona, thread, se, script: (step) => scripts.get(se.id).push(step), idle };
}
const card = (page, text) => page.locator('.transcript .block', { hasText: text });

test('#237 Shell turned on from the quick panel answers the card that asked for it, and the agent carries on', async ({ page }) => {
  const { rt, store } = app;
  const { persona, thread, se, script, idle } = await agent(page, 'shelly');
  script((ctx) => ctx.tools.ask_for_tool({ tool: 'shell', why: 'To run the tests.' }));
  rt.sendMessage(thread.id, { text: 'Run the tests.' });
  const ask = card(page, 'asks you to turn on “Run commands');
  await expect(ask.locator('.block-foot')).toBeVisible();
  await idle();
  await expect.poll(() => store.state.sessions[se.id].needs?.kind, { message: 'the agent to need you' }).toBe('toolask');
  await synced(page, app);
  const turns = heard.filter((m) => m.sessionId === se.id).length;
  // Its name in the sidebar opens its quick panel, needing you or not (#320), where Shell is a switch for the persona.
  await page.locator('.rail .agent-row .agent-btn', { has: page.locator('b', { hasText: /^@shelly$/ }) }).click();
  await page.locator('.backdrop .dialog.quick [role=switch][aria-label^="Shell"]').click();
  await expect(ask, 'the card answered').toContainText('Turned on.');
  // textContent: the label is drawn in capitals.
  expect(await ask.locator('.kind').evaluate((k) => k.textContent)).toBe('Turned on · shell');
  await expect(ask.locator('.block-foot'), 'no button is left to press').toHaveCount(0);
  expect(store.state.personas[persona.id].tools, 'the persona has Shell').toContain('shell');
  await expect.poll(() => heard.filter((m) => m.sessionId === se.id).length, { message: 'the agent’s next turn' }).toBeGreaterThan(turns);
  await idle();
  const last = heard.filter((m) => m.sessionId === se.id).at(-1);
  expect(last.kind).toBe('notice');
  expect(last.text).toMatch(/turned on shell/);
  expect(store.state.sessions[se.id].needs, 'it no longer needs you').toBe(null);
});

test('#238 a refused chained command offers no Allow once or Always allow, and says why; a single command still does', async ({ page }) => {
  const { rt } = app;
  const { thread, script, idle } = await agent(page, 'tester');
  const refuse = (command, label) =>
    script((ctx) => ctx.denied({ toolUseId: `tu-${label}`, tool: 'Bash', input: { command }, label, reason: '[Data Exfiltration]', reasonType: 'classifier' }));
  refuse('cd src && python -m pytest -q 2>&1 | tail -20', 'Run the chained tests');
  refuse('python -m pytest -q', 'Run the single tests');
  rt.sendMessage(thread.id, { text: 'Run the tests twice.' });
  rt.sendMessage(thread.id, { text: 'And again.' });
  const chained = card(page, 'tried to run the chained tests');
  const single = card(page, 'tried to run the single tests');
  await expect(chained.locator('.block-foot')).toBeVisible();
  await expect(single.locator('.block-foot')).toBeVisible();
  await idle();
  await synced(page, app);
  await expect(chained.locator('.block-foot button')).toHaveText(['Leave it']);
  await expect(chained.locator('.block-body')).toContainText(
    /Claude Code checks each part of a chained command \(joined by &&, \|\|, ;, \| or &\) against its rules on its own/,
  );
  await expect(chained.locator('.block-body')).toContainText('ask @tester to run the parts as separate commands');
  await expect(single.locator('.block-foot button')).toHaveText(['Allow once and retry', 'Always allow exactly “python -m pytest -q”', 'Leave it']);
  // The UAT runner reads these cards from the page the same way, for the allow-once scenario’s trigger (readUi).
  const facts = { threads: [thread.id], state: rt.s, ui: { denialCards: (await readUi(page)).denialCards } };
  expect(ALLOW_ONCE_TRIGGERS['chained-refusal-no-allow'].run(facts).length, 'the trigger sees the chained card only').toBe(1);
});

test('#281 a refused command with a * offers no rule and says why; one with env offers only its exact text', async ({ page }) => {
  const { rt } = app;
  const { thread, script, idle } = await agent(page, 'wild');
  const refuse = (command, label) =>
    script((ctx) => ctx.denied({ toolUseId: `tu-${label}`, tool: 'Bash', input: { command }, label, reason: '[Data Exfiltration]', reasonType: 'classifier' }));
  refuse('rm -rf build/*', 'Clear the build');
  refuse('env CI=1 make test', 'Run make');
  rt.sendMessage(thread.id, { text: 'Clean and test.' });
  rt.sendMessage(thread.id, { text: 'And again.' });
  const wild = card(page, 'tried to clear the build');
  const env = card(page, 'tried to run make');
  await expect(wild.locator('.block-foot')).toBeVisible();
  await expect(env.locator('.block-foot')).toBeVisible();
  await idle();
  await synced(page, app);
  await expect(wild.locator('.block-foot button')).toHaveText(['Leave it']);
  await expect(wild.locator('.block-body')).toContainText('Claude Code reads * in a rule as a wildcard');
  await expect(wild.locator('.block-body')).toContainText('ask @wild to name the files instead of using *');
  await expect(env.locator('.block-foot button')).toHaveText(['Allow once and retry', 'Always allow exactly “env CI=1 make test”', 'Leave it']);
});

test('#220 a permission card nobody answered for 25 hours says it expired, and how long it waited', async ({ page }) => {
  const { rt, store } = app;
  const { thread, script, idle } = await agent(page, 'waiter');
  const answers = [];
  script(async (ctx) => {
    answers.push(await ctx.askPermission({ tool: 'Bash', summary: 'run the slow tests', input: { command: 'npm run slow' } }));
  });
  rt.sendMessage(thread.id, { text: 'Run the slow tests.' });
  const ask = card(page, 'run the slow tests?');
  await expect(ask.locator('.block-foot')).toBeVisible();
  const open = store.items(thread.id).find((i) => i.kind === 'permission' && i.status === 'open');
  // What the card’s timer does at CARD_WAIT_MS; the server’s tests run that timer on an injected clock.
  expireWait(rt, open.id);
  await expect(ask.locator('.answered-note')).toHaveText('Expired: nobody answered within 25 hours');
  await expect(ask.locator('.block-foot'), 'nothing is left to answer').toHaveCount(0);
  await expect.poll(() => answers.length, { message: 'the answer to reach the agent' }).toBe(1);
  await idle();
  expect(answers[0].allow).toBe(false);
});
