// The Model field of an agent that runs on a host suggests what the host’s own CLI lists (#1304): the persona sheet
// asks the host’s daemon (`models`, answered by `listed`), not this computer. With a fake host manager
// (tests/browser/remote-hosts.mjs) whose link answers as a daemon does; Codex is only on the host here.
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
 * so no list is cached from another.
 * @param {string} name @param {(harness: string) => any} reply
 */
function hostWith(name, reply) {
  const { rt } = started.app;
  const host = rt.addHost({ name });
  const welcome = {
    version: '0.18.0',
    home: '/home/user',
    node: { version: '22.12.0', path: '/usr/bin/node' },
    harnesses: [{ name: 'codex', path: '/home/user/.local/bin/codex', version: '0.50.0' }],
    problems: [],
    turns: [],
  };
  started.hosts.set(host.id, { state: 'connected', failure: null, welcome, lastHeard: Date.now(), name });
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

test('a host whose Postbox is older than model lists says so in the field', async ({ page }) => {
  const { persona } = hostWith('old.example.com', () => ({ type: 'error', code: 'internal', re: 'models', message: 'This daemon doesn’t handle models yet.' }));
  const sheet = await openPersona(page, persona);
  const help = sheet.locator('[data-model-help]');
  await expect(help).toHaveText(
    /Codex on old\.example\.com didn’t list its models; if Postbox there is older than this one, install this version under Settings, Hosts\./,
  );
  await expect.soft(sheet.getByLabel('Model', { exact: true })).toHaveAccessibleDescription(/didn’t list its models/);
});
