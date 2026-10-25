// Permissions (#66, #10, #74), driven with real clicks and key presses:
// - each answer on a permission card (Always allow with its rule shown first, Edit, Don’t allow with a reason, a
//   subagent’s prompt named) reaches the waiting tool call;
// - a Codex MCP approval, a write outside Postbox with its draft (#112), and an ask for a tool that’s off (#104);
// - the panel opens from the conversation’s ⋯ and from the persona editor, and shows the mode, the rules with their
//   sources, the folders, the MCP servers and the effective view; adding a rule and changing the mode work;
// - a write without the page’s token gets 403.
// With a scripted Claude Code agent (no real turns) working in a temp folder, and a home of its own for user settings.
// Moved from tools/check-permissions.mjs (#303).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { codexApproval } from '../../server/adapters/codex.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced, windowWidth } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** The agent’s folder, what its scripted turns do next, and the answers its tool calls got. */
let work;
const script = [];
const answers = [];
let persona;
let thread;

test.beforeAll(async () => {
  app = await startPostbox('permissions', {
    // One rule in each settings file, so the panel has a source of each kind to show.
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(join(work, '.claude'), { recursive: true });
      await mkdir(join(root, '.claude'), { recursive: true });
      await mkdir(join(work, 'data'));
      await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'] } }));
      await writeFile(join(work, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
      await writeFile(join(work, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }));
    },
  });
  const { rt, store } = app;
  // A Claude Code agent whose turns this spec scripts: it asks permission, the way the CLI’s prompt tool does.
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return work;
    },
    async deliver(_session, _message, ctx) {
      const step = script.shift();
      if (step) await step(ctx);
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_check', name: 'Check', folder: work });
  persona = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  thread = rt.createThread({ projectId: 'pr_check', title: 'Permissions check', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** Opens the conversation and waits for it to have heard everything the server did. */
async function open(page) {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect(page.locator('#composer-input')).toBeVisible();
}

/** What a reader sees in an element: its innerText, a flex row’s items as separate words. */
const words = async (locator) => (await locator.allInnerTexts()).join(' ').replace(/\s+/g, ' ').trim();
const focused = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim().slice(0, 40) || '');
const idle = () => expect.poll(() => app.rt.turns.size, { message: 'the agent’s turn to end' }).toBe(0);

const card = (page, summary) => page.locator('.transcript .block', { hasText: summary });
const footButton = (c, name) => c.locator('.block-foot').getByRole('button', { name, exact: true });
/**
 * Waits for a card to show its buttons, and then for the page to have heard everything the server sent so far: a later
 * event about the card redraws it, and a click that lands while it does is lost.
 */
async function ready(page, c) {
  await expect(c.locator('.block-foot')).toBeVisible();
  await synced(page, app);
}
/** Starts a turn whose agent asks once, and waits for the card. Returns the card, and the answer once it comes. */
async function asking(page, req) {
  const n = answers.length;
  script.push(async (ctx) => {
    answers.push(await ctx.askPermission(req));
  });
  app.rt.sendMessage(thread.id, { text: `Please ${req.summary}.` });
  const c = card(page, req.summary);
  await ready(page, c);
  /** Waits for the agent to have the answer, and for the page to show what the server made of it. */
  const answer = async () => {
    await expect.poll(() => answers.length, { message: 'the answer to reach the agent' }).toBeGreaterThan(n);
    await idle();
    await synced(page, app);
    return answers[n];
  };
  return { c, answer };
}
/** Waits for the card’s editor (the command, or the input as JSON) to have focus, and selects what’s in it. */
async function selectEditor(page) {
  await expect.poll(() => focused(page), { message: 'focus in the editor' }).toMatch(/-edit$/);
  await page.keyboard.press('ControlOrMeta+a');
}

// ── Cards ───────────────────────────────────────────────────────────────────────────────

test('#66 Always allow shows the rule and where it’s saved before you click, and returns the suggestions', async ({ page }) => {
  await open(page);
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'make test:*' }], behavior: 'allow', destination: 'session' }];
  const { c, answer } = await asking(page, { tool: 'Bash', summary: 'run the tests', detail: 'make test', input: { command: 'make test' }, suggestions });
  const always = await words(c.locator('.perm-always'));
  expect(always).toMatch(/Always allow Bash\(make test:\*\) in this folder \(\.claude\/settings\.local\.json\)/);
  expect(always).toMatch(/session only.*local settings instead/);
  await footButton(c, 'Always allow').click();
  const a = await answer();
  expect(a.allow).toBe(true);
  expect(a.updatedPermissions[0].destination).toBe('localSettings');
  await expect(c).toContainText(/Always allowed \(Bash\(make test:\*\)\)/);
  await expect(page.locator('#composer-input'), 'focus goes back to the composer').toBeFocused();
});

test('#66 without suggestions (as the CLI asks), Always allow saves Postbox’s rule in the folder’s local settings', async ({ page }) => {
  await open(page);
  const { c, answer } = await asking(page, { tool: 'Bash', summary: 'run the linter', detail: 'npm run lint', input: { command: 'npm run lint' } });
  await expect(c.locator('.perm-always')).toContainText(/Always allow Bash\(npm run:\*\) in this folder/);
  await footButton(c, 'Always allow').click();
  expect(await answer()).toEqual({ allow: true });
  const local = JSON.parse(await readFile(join(work, '.claude', 'settings.local.json'), 'utf8'));
  expect(local.permissions.allow).toContain('Bash(npm run:*)');
});

test('#10 Edit changes the command by keyboard, and the changed command is what runs', async ({ page }) => {
  await open(page);
  const { c, answer } = await asking(page, { tool: 'Bash', summary: 'clean the build', detail: 'rm -rf build', input: { command: 'rm -rf build' } });
  await footButton(c, 'Edit…').click();
  await selectEditor(page);
  await page.keyboard.insertText('rm -rf build/tmp');
  await c.locator('.perm-form').getByRole('button', { name: 'Allow with this edit' }).click();
  expect(await answer()).toEqual({ allow: true, updatedInput: { command: 'rm -rf build/tmp' } });
  await expect(c).toContainText(/Allowed with your edit.*rm -rf build\/tmp/);
});

test('#10 Edit of a JSON input that doesn’t parse says so, and nothing is sent', async ({ page }) => {
  await open(page);
  const n = answers.length;
  const { c, answer } = await asking(page, {
    tool: 'WebFetch',
    summary: 'fetch the docs',
    detail: 'https://a.example/',
    input: { url: 'https://a.example/', prompt: 'p' },
  });
  await footButton(c, 'Edit…').click();
  await selectEditor(page);
  await page.keyboard.insertText('{ "url": ');
  const allow = c.locator('.perm-form').getByRole('button', { name: 'Allow with this edit' });
  await allow.click();
  await expect(c.locator('.perm-form .err')).toContainText('doesn’t parse');
  expect(answers.length, 'nothing was sent').toBe(n);
  await selectEditor(page);
  await page.keyboard.insertText('{ "url": "https://b.example/", "prompt": "p" }');
  await allow.click();
  expect((await answer()).updatedInput).toEqual({ url: 'https://b.example/', prompt: 'p' });
});

test('#10 Don’t allow takes a reason by keyboard, and the agent reads it', async ({ page }) => {
  await open(page);
  const { c, answer } = await asking(page, {
    tool: 'Bash',
    summary: 'push to main',
    detail: 'git push origin main',
    input: { command: 'git push origin main' },
  });
  await footButton(c, 'Don’t allow…').click();
  await expect.poll(() => focused(page), { message: 'focus on the reason' }).toMatch(/-why$/);
  await page.keyboard.insertText('Open a pull request instead.');
  await page.keyboard.press('Enter');
  expect(await answer()).toEqual({ allow: false, message: 'The person didn’t allow this. Their reason: Open a pull request instead.' });
  await expect(c).toContainText('Your reason: Open a pull request instead.');
});

test('#66 a subagent’s prompt names the subagent', async ({ page }) => {
  await open(page);
  const n = answers.length;
  script.push(async (ctx) => {
    ctx.subagentNames(({ toolUseId }) => (toolUseId === 'toolu_sub' ? 'Explore' : null));
    answers.push(await ctx.askPermission({ tool: 'Bash', summary: 'list the files', detail: 'ls', input: { command: 'ls' }, toolUseId: 'toolu_sub' }));
  });
  app.rt.sendMessage(thread.id, { text: 'Look around.' });
  const c = card(page, 'list the files');
  await ready(page, c);
  await expect(c.locator('.title')).toContainText('Let @coder’s subagent (Explore) list the files?');
  await footButton(c, 'Allow').click();
  await expect.poll(() => answers[n]?.allow, { message: 'the answer to reach the subagent' }).toBe(true);
  await idle();
});

test('#150 a Codex approval for an MCP tool names the tool and shows its arguments, with a title that reads cleanly', async ({ page }) => {
  await open(page);
  const replies = [];
  script.push(async (ctx) => {
    // What Codex’s app-server sends before a third-party MCP call (server/adapters/codex.mjs).
    const request = {
      id: 91,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'github',
        message: 'Allow the github MCP server to run tool "create_issue"?',
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_description: 'Create a GitHub issue.', tool_params: { title: 'Glossary links break' } },
      },
    };
    replies.push(await codexApproval(ctx, request));
  });
  app.rt.sendMessage(thread.id, { text: 'File the issue.' });
  const c = card(page, 'use github tool create_issue');
  await ready(page, c);
  expect(await words(c.locator('.title'))).toBe('Let @coder use github tool create_issue?');
  // The tool’s name keeps its case: the label around it is uppercase.
  expect(await words(c.locator('.kind .tool-name'))).toBe('mcp__github__create_issue');
  const detail = await words(c.locator('.perm-detail'));
  expect(detail).toMatch(/Create a GitHub issue\./);
  expect(detail).toMatch(/"title": "Glossary links break"/);
  expect(await words(c)).not.toMatch(/run a command|Codex wants/);
  await footButton(c, 'Allow').click();
  await expect.poll(() => replies.length, { message: 'the answer to reach Codex' }).toBe(1);
  await idle();
  expect(replies[0]).toEqual({ action: 'accept', content: {} });
});

test('#112 a write outside Postbox waits on a card with its draft as it will read; Always allow lets the next one through', async ({ page }) => {
  const { rt, store } = app;
  await open(page);
  const replies = [];
  const req = {
    tool: 'mcp__docs__create_document',
    summary: 'use create document from docs',
    detail: '{}',
    input: { folder: 'Use cases', title: '05 · Search', content: '# 05 · Search\n\n## Problem\n\nRunbooks are **hard** to find.' },
  };
  script.push(async (ctx) => {
    replies.push(await ctx.askPermission(req));
  });
  rt.sendMessage(thread.id, { text: 'Define the use case document in the team folder.' });
  const write = card(page, 'use create document from docs');
  await ready(page, write);
  await expect(write).toContainText('This writes outside Postbox, to docs (folder “Use cases”). Nothing is created, sent or changed until you allow it.');
  // The draft is rendered, not shown as JSON, and the arguments point up at it.
  const draft = write.locator('.perm-draft');
  await expect(draft.getByRole('heading', { name: '05 · Search' })).toBeVisible();
  await expect(draft.locator('strong')).toHaveText('hard');
  await expect(draft).toHaveAttribute('aria-label', 'The draft');
  await expect(write.locator('.perm-detail')).toContainText('"content": "(the draft above)"');
  await expect(write.locator('.perm-always')).toContainText('Always allow mcp__docs__create_document in this folder');
  await expect(write.locator('.perm-always')).toContainText('From now on @coder can use mcp__docs__create_document without showing you a draft.');
  await footButton(write, 'Always allow').click();
  await expect.poll(() => replies.length, { message: 'the answer' }).toBe(1);
  await idle();
  expect(replies[0].allow).toBe(true);
  // The next one: Claude Code asks again (ask beats allow), and Postbox lets it through without a card.
  script.push(async (ctx) => {
    replies.push(await ctx.askPermission({ ...req, input: { ...req.input, title: '06 · Ranking' } }));
  });
  const cards = store.items(thread.id).filter((i) => i.kind === 'permission').length;
  rt.sendMessage(thread.id, { text: 'And the ranking one.' });
  await expect.poll(() => replies.length, { message: 'the second write' }).toBe(2);
  await idle();
  expect(replies[1]).toEqual({ allow: true });
  expect(store.items(thread.id).filter((i) => i.kind === 'permission').length, 'no second card').toBe(cards);
});

test('#104 an agent asks for a tool that’s off; the card says what turning it on does, and the button turns it on', async ({ page }) => {
  const { rt, store } = app;
  await open(page);
  const asked = [];
  script.push(async (ctx) => {
    asked.push(ctx.tools.ask_for_tool({ tool: 'agents.outside', why: 'To schedule the nightly run with CronCreate.' }));
  });
  rt.sendMessage(thread.id, { text: 'Schedule the nightly run.' });
  const ask = page.locator('.transcript .block', { hasText: 'asks you to turn on “Message, schedule' });
  try {
    await ready(page, ask);
    expect(asked[0].ok).toBe(true);
    expect(await words(ask.locator('.title'))).toBe('@coder asks you to turn on “Message, schedule or start agents outside Postbox”');
    const body = await words(ask.locator('.block-body'));
    expect(body).toMatch(/It’s turned off for @coder in Postbox, so it can’t use it here\./);
    // The id is the label beside the title, in its own case.
    expect(await words(ask.locator('.kind .tool-name'))).toBe('agents.outside');
    expect(body).toMatch(/@coder: To schedule the nightly run with CronCreate\./);
    expect(body).toMatch(/in every conversation, from its next turn\. Its permission mode still decides each call\./);
    await footButton(ask, 'Turn on for @coder').click();
    await expect(ask, 'the answered card').toContainText('Turned on.');
    expect(store.state.personas[persona.id].tools, 'the persona has it ticked').toContain('agents.outside');
    await expect(page.locator('#composer-input'), 'focus goes back to the composer').toBeFocused();
    await idle();
  } finally {
    rt.updatePersona(persona.id, { tools: ['shell'] });
  }
});

// ── The panel ───────────────────────────────────────────────────────────────────────────

/** Opens the permissions panel from the conversation’s ⋯. */
async function openPanel(page) {
  await page.locator('header.topbar button[aria-label^="Actions for"]').click();
  await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
  await expect(page.locator('.dialog .perm-panel #perm-call'), 'the panel').toBeVisible();
  return page.locator('.dialog');
}

test('#66 the panel opens from ⋯ › Permissions… with the mode, rules with sources, folders, MCP servers and the effective view', async ({ page }) => {
  await open(page);
  const dialog = await openPanel(page);
  const all = await words(dialog);
  expect(all).toMatch(/@coder’s permissions/);
  await expect(dialog.locator('[role="radiogroup"][aria-label="Mode"] [aria-checked="true"]')).toContainText('Ask me');
  expect(all).toMatch(/Bash\(rm:\*\) from the project’s shared settings/);
  expect(all).toMatch(/Bash\(git status\) from your user settings/);
  expect(all).toMatch(/Bash\(npm test:\*\) from this folder’s local settings/);
  expect(all).toMatch(/WebFetch, WebSearch, Monitor from the persona’s Tools: web\.fetch is unticked/);
  expect(all).toMatch(/and \d+ more, from Postbox’s check on writes outside it: tools and gh commands that create, change or delete/);
  expect(all).toMatch(/Folders.*Where it works/i);
  expect(all).toMatch(/MCP servers/i);
  expect(all).toMatch(/Claude Code has the final say/);
  // The effective view, as you type.
  const call = page.locator('#perm-call');
  const verdict = page.locator('.perm-verdict');
  for (const [typed, says] of [
    ['Bash(rm -rf build)', /Refused by the deny rule Bash\(rm:\*\) from the project’s shared settings/],
    ['Bash(npm test -- --ci)', /Runs: the allow rule Bash\(npm test:\*\) from this folder’s local settings/],
    ['WebFetch(https://example.com/x)', /Refused by the deny rule WebFetch from the persona’s Tools/],
    ['Bash(make)', /No rule covers it, so Ask me mode decides: @coder asks you/],
    ['mcp__github__create_issue', /Asks you: the ask rule mcp__\*__create\* from Postbox’s check on writes outside it/],
  ]) {
    await call.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(typed);
    await expect(verdict).toContainText(says);
  }
});

test('#66 a rule added in the panel is saved where you chose, and shows with its source', async ({ page }) => {
  const { rt, store } = app;
  await open(page);
  const dialog = await openPanel(page);
  // The default is this folder’s local settings, where the CLI saves “don’t ask again”.
  await expect(page.locator('#perm-w')).toHaveValue('local');
  await page.locator('#perm-p').click();
  await page.keyboard.insertText('make:*');
  await expect(page.locator('.perm-add code.perm-rule')).toHaveText('Bash(make:*)');
  await page.locator('.perm-add').getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog, 'the local rule').toContainText(/Bash\(make:\*\)\s*from this folder’s local settings/);
  const local = JSON.parse(await readFile(join(work, '.claude', 'settings.local.json'), 'utf8'));
  expect(local.permissions.allow).toContain('Bash(make:*)');
  // This conversation only, on request.
  await page.locator('#perm-w').selectOption('conversation');
  await page.locator('#perm-p').click();
  await page.keyboard.insertText('npx prettier:*');
  await page.locator('.perm-add').getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog, 'the new rule').toContainText(/Bash\(npx prettier:\*\)\s*from this conversation/);
  const se = rt.sessionsIn(thread.id)[0];
  expect(store.state.sessions[se.id].rules.allow).toEqual(['Bash(npx prettier:*)']);
  // The project’s shared file has no Remove; a local one does.
  await expect(dialog.locator('.list-rows li', { hasText: 'Bash(rm:*)' }), 'the shared rule is listed').toHaveCount(1);
  await expect(dialog.locator('.list-rows li', { hasText: 'Bash(rm:*)' }).locator('button')).toHaveCount(0);
  await expect(dialog.locator('.list-rows li', { hasText: 'Bash(make:*)' }).locator('button[aria-label^="Remove"]')).toHaveCount(1);
});

test('#66 the mode changes from the panel, and says it applies from the next turn', async ({ page }) => {
  await open(page);
  const dialog = await openPanel(page);
  try {
    await dialog.locator('[aria-label="Mode"] button', { hasText: 'Accept edits' }).click();
    await expect(dialog.locator('.perm-status')).toContainText('@coder is in Accept edits mode from its next turn');
    expect(app.store.state.personas[persona.id].permissionMode).toBe('acceptEdits');
  } finally {
    app.rt.updatePersona(persona.id, { permissionMode: 'ask' });
  }
});

test('#66 a folder added from the panel’s folder picker is listed for this conversation', async ({ page }) => {
  await open(page);
  const dialog = await openPanel(page);
  await dialog.getByRole('button', { name: 'Add folder…' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Add data', exact: true }).click();
  await expect(page.locator('.dialog', { hasText: 'Permissions' }).first(), 'the added folder').toContainText('From this conversation');
  const se = app.rt.sessionsIn(thread.id)[0];
  expect(app.store.state.sessions[se.id].addDirs).toEqual([join(work, 'data')]);
  // Choosing closes only the picker, not the panel it was opened over.
  await expect(page.locator('.backdrop')).toHaveCount(1);
});

test('#66 the persona editor opens the same panel', async ({ page }) => {
  await open(page);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
  await page.locator('#pe-perms').click();
  await expect(page.locator('.backdrop')).toHaveCount(2);
  const over = page.locator('.backdrop').last();
  await expect(over.locator('.perm-panel #perm-call'), 'the panel over the editor').toBeVisible();
  await expect(over.locator('.d-head')).toContainText('@coder’s permissions');
  await page.keyboard.press('Escape');
  await expect(page.locator('.backdrop'), 'Escape closes the panel and keeps the editor').toHaveCount(1);
});

// ── #74 ─────────────────────────────────────────────────────────────────────────────────

test('#74 a write without the page’s token gets 403; the page’s own writes go through', async ({ page }) => {
  const r = await fetch(`${app.origin}/api/permissions/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personaId: persona.id, behavior: 'allow', rule: 'Bash' }),
  });
  expect(r.status).toBe(403);
  expect((await r.json()).error).toMatch(/came from outside the Postbox page/);
  await open(page);
  const inPage = await page.evaluate(
    (id) => fetch(`/api/threads/${id}/view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((x) => x.status),
    thread.id,
  );
  expect(inPage).toBe(200);
  // Loading / without a browser’s headers gets the page, not the token.
  const bare = await fetch(`${app.origin}/`);
  await bare.arrayBuffer();
  expect(bare.headers.get('set-cookie')).toBe(null);
});

test('#74 a page whose token is gone (as after a restart) gets a new one by fetching /, and the write goes through', async ({ page, context }) => {
  await open(page);
  await context.clearCookies();
  // The write without a token is refused once, before the page fetches a new one.
  allowPageError(page, /status of 403/);
  const write = (id) =>
    import('/app/js/client.mjs')
      .then((m) => m.api(`/api/threads/${id}/view`, {}))
      .then(() => 'ok')
      .catch((e) => e.message);
  const r = await page.evaluate(write, thread.id);
  expect(r, 'the browser’s same-origin fetch of / carries Sec-Fetch-Site: same-origin, so it gets the token').toBe('ok');
});

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('#66 the panel fits a narrow window (375 px) without scrolling sideways', async ({ page }) => {
    await open(page);
    await openPanel(page);
    const over = await page.locator('.dialog').evaluate((d, w) => [d.scrollWidth - d.clientWidth, document.documentElement.scrollWidth - w], windowWidth(page));
    expect(over, 'nothing overflows sideways').toEqual([0, 0]);
  });
});
