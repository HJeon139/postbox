// The Model field of an agent that runs on a host suggests what the host’s own CLI lists (#1304): the persona sheet
// asks the host’s daemon (`models`, answered by `listed`), not this computer. With a fake host manager
// (tests/browser/remote-hosts.mjs) whose link answers as a daemon does; Codex is only on the host here.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { startRemote } from './remote-hosts.mjs';

/** @type {Awaited<ReturnType<typeof startRemote>>} */
let started;
test.beforeAll(async () => {
  started = await startRemote('host-models');
});
test.afterAll(async () => {
  await started?.app.stop();
});
failOnPageErrors(test);

/**
 * A host whose daemon answers `models` with reply(harness), and a Codex persona placed on it. Each test has its own,
 * so no list is cached from another. codexPath: where the host’s welcome finds Codex once the agent is placed there,
 * null for nowhere, as when it’s gone from the host since.
 * @param {string} name @param {(harness: string) => any} reply @param {{ codexPath?: string | null }} [o]
 */
function hostWith(name, reply, { codexPath = '/home/user/.local/bin/codex' } = {}) {
  const { rt } = started.app;
  const host = rt.addHost({ name });
  /** @param {string | null} path */
  const welcome = (path) => ({
    version: '0.18.0',
    home: '/home/user',
    node: { version: '22.12.0', path: '/usr/bin/node' },
    harnesses: [{ name: 'codex', path, version: path ? '0.50.0' : null, looked: ['/home/user/.local/bin/codex'] }],
    problems: [],
    turns: [],
  });
  /** @param {string | null} path */
  const connected = (path) => started.hosts.set(host.id, { state: 'connected', failure: null, welcome: welcome(path), lastHeard: Date.now(), name });
  connected('/home/user/.local/bin/codex');
  const link = started.hosts.link(host.id);
  const asked = [];
  link.send = (msg) => {
    if (msg.type === 'models') {
      asked.push(msg.harness);
      setImmediate(() => link.emit('message', reply(msg.harness)));
    }
    return true;
  };
  const persona = rt.createPersona({ handle: `on-${name.split('.')[0]}`, backend: 'codex', remote: { hostId: host.id } });
  connected(codexPath);
  return { host, persona, asked };
}

async function openPersona(page, persona) {
  await page.goto(`${started.app.origin}/`);
  await synced(page, started.app);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
  return page.getByRole('dialog');
}
const suggested = (sheet) => sheet.locator('#pe-models option').evaluateAll((options) => options.map((o) => /** @type {HTMLOptionElement} */ (o).value));

test('an agent on a host suggests what the host’s CLI lists, with Codex’s auto beside it', async ({ page }) => {
  const { persona, asked } = hostWith('gpu.example.com', (harness) => ({ type: 'listed', harness, models: ['gpt-6.1-sol', 'gpt-5.6-terra'] }));
  const sheet = await openPersona(page, persona);
  await expect.poll(() => suggested(sheet)).toEqual(['gpt-6.1-sol', 'gpt-5.6-terra', 'auto']);
  expect.soft(asked).toEqual(['codex']);
  await expect.soft(sheet.locator('[data-model-help]')).toHaveCount(0);
});

// What a daemon from before `models` answers it, recorded from main’s daemon at 5b0ef806.
const BEFORE_MODELS = JSON.parse(readFileSync(new URL('../fixtures/remote/models-before-1312.json', import.meta.url), 'utf8'));

test('a host whose Postbox is older than model lists says so in the field, at once', async ({ page }) => {
  const { persona } = hostWith('old.example.com', () => BEFORE_MODELS);
  const sheet = await openPersona(page, persona);
  const help = sheet.locator('[data-model-help]');
  // Well inside the 45 s Postbox would wait for an answer that isn’t coming.
  await expect(help).toHaveText(
    /^Postbox on old\.example\.com is older than this one and can’t list models; install this version there under Settings, Hosts\./,
    {
      timeout: 5000,
    },
  );
  await expect.soft(sheet.getByLabel('Model', { exact: true })).toHaveAccessibleDescription(/is older than this one/);
});

test('a host whose CLI lists nothing says so, without asking to install Postbox there', async ({ page }) => {
  const { persona } = hostWith('bare.example.com', (harness) => ({ type: 'listed', harness, models: [] }));
  const sheet = await openPersona(page, persona);
  const help = sheet.locator('[data-model-help]');
  await expect(help).toHaveText(/^Codex on bare\.example\.com didn’t list its models\. Type the model you want/);
  await expect.soft(help).not.toContainText('install');
});

test('a host without the CLI says it wasn’t found there, not that Postbox there is older', async ({ page }) => {
  const { persona } = hostWith('nocli.example.com', (harness) => ({ type: 'listed', harness, models: [] }), { codexPath: null });
  const sheet = await openPersona(page, persona);
  const help = sheet.locator('[data-model-help]');
  await expect(help).toHaveText(
    'Codex wasn’t found on nocli.example.com, so it couldn’t list its models. Type the model you want: it goes to Codex there as --model.',
  );
  await expect.soft(help).not.toContainText('install');
});

// #1977: a harness lists the models it knows, not the ones the sign-in may run. On the owner’s host the first listed
// was refused, and so was the next they picked. The field orders its suggestions by how each one’s last turn there
// ended, and says so for the model in it.
test('suggestions are ordered by how each model’s last turn on the host ended, and the field says so for the model in it', async ({ page }) => {
  const { host, persona } = hostWith('bedrock.example.com', (harness) => ({ type: 'listed', harness, models: ['gpt-9-new', 'gpt-6.1-sol', 'gpt-5.6-terra'] }));
  const at = Date.now() - 5 * 60_000;
  writeFileSync(
    join(started.app.root, 'data', 'model-runs.json'),
    JSON.stringify({
      [`codex@${host.id}`]: {
        'gpt-9-new': { ended: 'failed', at, why: '403 gpt-9-new is not available for this account' },
        'gpt-5.6-terra': { ended: 'answered', at },
        'typed-by-hand': { ended: 'answered', at: at - 1000 },
      },
    }),
  );
  const sheet = await openPersona(page, persona);
  // Answered first, a typed one among them; then the untried, Codex’s auto with them; the failed one last, not hidden.
  await expect.poll(() => suggested(sheet)).toEqual(['gpt-5.6-terra', 'typed-by-hand', 'gpt-6.1-sol', 'auto', 'gpt-9-new']);

  const field = sheet.getByLabel('Model');
  const line = sheet.locator('[data-model-ran]');
  const box = await sheet.getByRole('button', { name: 'Save' }).boundingBox();
  await field.fill('gpt-9-new');
  await expect(line).toHaveText(
    'This model’s last turn on bedrock.example.com failed before its first step, 5 min ago: 403 gpt-9-new is not available for this account. It may run now: Postbox doesn’t know until a turn tries.',
  );
  await field.fill('gpt-5.6-terra');
  await expect(line).toHaveText('This model’s last turn on bedrock.example.com answered, 5 min ago.');
  await expect(field).toHaveAccessibleDescription(/last turn on bedrock\.example\.com answered/);
  // A model no turn has tried says nothing, and its line is kept, so typing moves nothing below the field.
  await field.fill('gpt-6.1-sol');
  await expect(line).toHaveText('');
  expect.soft((await sheet.getByRole('button', { name: 'Save' }).boundingBox())?.y).toBe(box?.y);
});

test('with nothing kept for a host the field is as it was: the harness’s order, and no line', async ({ page }) => {
  const { persona } = hostWith('fresh.example.com', (harness) => ({ type: 'listed', harness, models: ['gpt-6.1-sol', 'gpt-5.6-terra'] }));
  const sheet = await openPersona(page, persona);
  await expect.poll(() => suggested(sheet)).toEqual(['gpt-6.1-sol', 'gpt-5.6-terra', 'auto']);
  await expect(sheet.locator('[data-model-ran]')).toHaveCount(0);
});

test('the model Postbox fills in for a new agent on a host is one that answered there, not the first its CLI lists', async ({ page }) => {
  const { host } = hostWith('picks.example.com', (harness) => ({ type: 'listed', harness, models: ['gpt-9-new', 'gpt-5.6-terra'] }));
  writeFileSync(
    join(started.app.root, 'data', 'model-runs.json'),
    JSON.stringify({
      [`codex@${host.id}`]: { 'gpt-9-new': { ended: 'failed', at: Date.now(), why: 'refused' }, 'gpt-5.6-terra': { ended: 'answered', at: Date.now() } },
    }),
  );
  await page.goto(`${started.app.origin}/`);
  await synced(page, started.app);
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas')));
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'New agent' }).click();
  await sheet.getByLabel('Backend').selectOption('codex');
  await sheet.getByLabel('Runs on').selectOption(host.id);
  await expect(sheet.getByLabel('Model')).toHaveValue('gpt-5.6-terra');
  await expect(sheet.locator('[data-model-ran]')).toHaveText(/last turn on picks\.example\.com answered/);
});
