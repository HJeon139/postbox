// A host’s status in the Hosts tab of Settings (#120), as the host manager reports it: a failed sign-in with the
// command to run, a host key, another Postbox driving it with Take over and its confirm, the daemon’s findings with
// the linger warning and where it looked for a missing harness; and removing a host: the confirm saying it removes
// Postbox from the host (or, with no token here, only forgets it), refused with a 409 that names the turn it can’t
// stop, refused again when the host can’t be reached, with the next step, then removed. Each step is checked at 1280
// and 375 px, with axe. Adding, installing and editing a host are hosts.spec.mjs. With a fake host manager
// (tests/browser/hosts.mjs), so nothing connects to a host. Moved from tools/check-hosts-status.mjs (#303).

import { expect, test } from '@playwright/test';
import { classifyExit, failure } from '../../server/remote/ssh.mjs';
import { escapeRegExp } from '../../shared/regex.mjs';
import { audit, card, freshHost, MINUTE, openHosts, SIZES, startHosts } from './hosts.mjs';
import { allowPageError, failOnPageErrors } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startHosts>>['app']} */
let app;
/** @type {Awaited<ReturnType<typeof startHosts>>['fake']} */
let fake;
test.beforeAll(async () => {
  ({ app, fake } = await startHosts('hosts-status'));
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const NAME = 'build.example.com';
const connects = () => fake.calls.filter((c) => c[0] === 'connect');
/** A failure as the manager reports it, from ssh’s exit. @param {string} stderr */
const exited = (stderr) => {
  const f = classifyExit({ destination: NAME, code: 255, signal: null, stderr });
  return { kind: f.kind, message: f.message, next: f.next, retry: false };
};
/** What the daemon says when it connects: Node, Claude Code, two harnesses it didn’t find, and lingering off. */
const WELCOME = {
  version: 2,
  home: '/home/user',
  node: { path: '/usr/bin/node', version: 'v22.11.0' },
  harnesses: [
    { name: 'claude-code', path: '/home/user/.local/bin/claude', version: '2.1.300', looked: ['/home/user/.local/bin/claude'] },
    { name: 'kiro-cli', path: null, version: null, looked: ['/home/user/.local/bin/kiro-cli', '/usr/local/bin/kiro-cli'] },
    { name: 'codex', path: null, version: null, looked: ['/home/user/.local/bin/codex'] },
  ],
  problems: [
    {
      code: 'no-linger',
      message:
        'Lingering is off for this user, so turns end when the last session on the host ends. Run “loginctl enable-linger” on the host to keep them running.',
    },
  ],
  turns: [],
};

/** @param {import('@playwright/test').Page} page */
async function signInAndKey(page) {
  const id = freshHost(app, fake, NAME);
  await openHosts(page, app);
  const c = card(page, NAME);
  const signIn = exited('user@build.example.com: Permission denied (publickey,gssapi-with-mic).\n');
  fake.set(id, { state: 'failed', failure: signIn, lastHeard: Date.now() - 3 * MINUTE });
  await expect(c.locator('.ho-failure[data-kind="sign-in"]'), 'the sign-in failure').toBeVisible();
  await expect.soft(c, 'a failed sign-in shows its message').toContainText(signIn.message);
  await expect.soft(c, 'and when it was last heard from').toContainText('Last heard from 3 min ago');
  await expect.soft(c.locator('.ho-cmd code'), 'it shows the command to run in a terminal').toHaveText(`ssh ${NAME}`);
  await expect.soft(c.getByRole('button', { name: `Copy ssh ${NAME}` }), 'with Copy').toBeVisible();
  await c.getByRole('button', { name: 'Reconnect' }).click();
  await expect.poll(connects, { message: 'Reconnect retries, without taking over' }).toEqual([['connect', id, { takeover: false }]]);
  await audit(page, 'a failed sign-in');

  const key = exited(
    '@@@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nOffending ECDSA key in /home/user/.ssh/known_hosts:12\nHost key verification failed.\n',
  );
  fake.set(id, { state: 'failed', failure: key });
  await expect(c.locator('.ho-failure[data-kind="host-key"]'), 'the host key failure').toBeVisible();
  await expect.soft(c.locator('.ho-cmd code'), 'a changed host key shows both commands, in order').toHaveText([`ssh-keygen -R ${NAME}`, `ssh ${NAME}`]);
}

/** @param {import('@playwright/test').Page} page */
async function takeOver(page) {
  const id = freshHost(app, fake, NAME);
  await openHosts(page, app);
  const busy = failure('busy', NAME, { why: 'The host’s daemon said: “Another Postbox is attached.”' });
  fake.set(id, { state: 'failed', failure: { kind: 'busy', message: busy.message, next: busy.next, retry: false } });
  await card(page, NAME).getByRole('button', { name: 'Take over…' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Take over ${NAME}?` });
  await expect(confirm, 'Take over asks first').toBeVisible();
  await expect.soft(confirm, 'saying another Postbox is driving the host').toContainText(`Another Postbox is connected to ${NAME} and driving it`);
  await expect.soft(confirm, 'and that its turns keep running').toContainText('Turns already running there keep running');
  expect.soft(connects(), 'asking takes nothing over').toEqual([]);
  await audit(page, 'the takeover confirm');
  await confirm.getByRole('button', { name: 'Take over', exact: true }).click();
  await expect.poll(connects, { message: 'Take over retries with takeover: true' }).toEqual([['connect', id, { takeover: true }]]);
  await expect(confirm, 'the confirm closes').toBeHidden();
}

/** @param {import('@playwright/test').Page} page */
async function daemonFound(page) {
  const id = freshHost(app, fake, NAME);
  await openHosts(page, app);
  const c = card(page, NAME);
  fake.set(id, { state: 'connected', lastHeard: Date.now(), welcome: WELCOME });
  const linger = c.locator('.ho-problem[data-code="no-linger"]');
  await expect(linger, 'the linger warning').toBeVisible();
  await expect.soft(linger, 'the linger warning says turns end with your last session').toContainText(`Turns on ${NAME} end when your last session there does`);
  await expect.soft(linger.locator('.ho-cmd code'), 'and how to turn lingering on').toHaveText('loginctl enable-linger');
  const found = c.getByLabel(`What Postbox found on ${NAME}`);
  await expect.soft(found, 'it shows Node’s version and path').toContainText('v22.11.0 at /usr/bin/node');
  await expect
    .soft(found, 'a missing harness says where the daemon looked')
    .toContainText(/Kiro CLI\s*Not found\. The daemon looked in \/home\/user\/\.local\/bin\/kiro-cli, \/usr\/local\/bin\/kiro-cli/);
  await expect.soft(c.locator('.status-tag'), 'connected says so').toHaveText('Connected');
  await audit(page, 'a connected host with warnings');
}

/** @param {import('@playwright/test').Page} page */
async function forgetOnly(page) {
  const id = freshHost(app, fake, NAME);
  fake.set(id, { state: 'not-installed' });
  await openHosts(page, app);
  await expect(card(page, NAME).locator('.status-tag')).toHaveText('Not installed');
  await card(page, NAME)
    .getByRole('button', { name: `Remove ${NAME}` })
    .click();
  const confirm = page.getByRole('alertdialog', { name: `Remove ${NAME}?` });
  const says = 'with no token here, the confirm says Postbox only forgets the host';
  await expect
    .soft(confirm, says)
    .toContainText(`This computer has no token for ${NAME}, so Postbox can’t reach anything of its own there. It forgets the host here`);
  await expect.soft(confirm, says).not.toContainText('deletes ~/.postbox-remote');
  await expect.soft(confirm.getByRole('button', { name: 'Remove host', exact: true }), says).toBeVisible();
  await audit(page, 'removing a host with no token here');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm, 'Cancel closes it').toBeHidden();
  expect.soft(fake.calls, 'and removes nothing').toEqual([]);
}

/** @param {import('@playwright/test').Page} page */
async function removing(page) {
  const id = freshHost(app, fake, NAME);
  fake.set(id, { state: 'connected', lastHeard: Date.now(), welcome: WELCOME });
  await openHosts(page, app);
  await expect(card(page, NAME).locator('.status-tag')).toHaveText('Connected');
  const se = Object.values(app.store.state.sessions)[0];
  const confirm = page.getByRole('alertdialog', { name: `Remove ${NAME}?` });
  await test.step('the confirm', () => removeAsks(page, confirm));
  await test.step('refused while a turn there can’t be stopped', () => refusedForTurn(page, id, se, confirm));
  await test.step('refused while the host can’t be reached', () => refusedUnreached(page, id, confirm));
  await test.step('removed', () => removed(page, id, confirm));
}

for (const { width, use } of SIZES)
  test.describe(`at ${width} px`, () => {
    test.use(use);

    test('#120 a failed sign-in shows the command to run and Reconnect, and a changed host key both commands in order', ({ page }) => signInAndKey(page));

    test('#120 with another Postbox driving the host, Take over asks first, then retries with takeover', ({ page }) => takeOver(page));

    test('#120 a connected host shows what the daemon found, where it looked for a missing harness, and the linger warning', ({ page }) => daemonFound(page));

    test('#120 with no token here, Remove… says Postbox only forgets the host', ({ page }) => forgetOnly(page));

    test('#120 Remove… asks first, is refused while a turn can’t be stopped and while the host can’t be reached, then removes it', ({ page }) =>
      removing(page));
  });

/** @param {import('@playwright/test').Page} page @param {import('@playwright/test').Locator} confirm */
async function removeAsks(page, confirm) {
  await card(page, NAME)
    .getByRole('button', { name: `Remove ${NAME}` })
    .click();
  await expect(confirm, 'Remove asks first').toBeVisible();
  await expect
    .soft(confirm, 'saying it stops the daemon and its turns there and deletes ~/.postbox-remote, then forgets the host')
    .toContainText(
      `Postbox stops the daemon and every turn still running on ${NAME}, and deletes ~/.postbox-remote there: its code, token, logs and turn records. Then it forgets the host here`,
    );
  const go = confirm.getByRole('button', { name: `Remove Postbox from ${NAME}` });
  await expect.soft(go, 'the confirm’s action names it: Remove Postbox from the host').toBeVisible();
  await expect
    .soft(confirm, 'it says what stays there, and that another Postbox using the host loses access')
    .toContainText(`working folders there, such as ~/postbox-work/<handle>, stay. Another Postbox that uses ${NAME} loses its access too`);
  await expect.soft(confirm.getByRole('button', { name: 'Cancel' }), 'Cancel has focus first, not the button that deletes').toBeFocused();
  await audit(page, 'the remove confirm');
}

/** @param {import('@playwright/test').Page} page @param {string} id @param {any} se @param {import('@playwright/test').Locator} confirm */
async function refusedForTurn(page, id, se, confirm) {
  // A turn there that can’t be stopped: this computer has no token to reach the host with.
  fake.noToken.add(id);
  app.rt.remote.stopping.set('tu_check', /** @type {any} */ ({ hostId: id, sessionId: se?.id ?? '', waiters: [] }));
  allowPageError(page, /status of 409/);
  try {
    await confirm.getByRole('button', { name: `Remove Postbox from ${NAME}` }).click();
    const why = confirm.getByRole('alert');
    await expect(why.locator('.callout'), 'the refusal').toBeVisible();
    await expect.soft(why, 'a 409 shows its message').toContainText('token isn’t on this computer any more, so Postbox can’t reach it to stop 1 running turn');
    await expect.soft(why, 'naming the turn it can’t stop').toContainText(se ? `@${se.handle}` : 'an agent');
    expect.soft(app.store.state.hosts[id], 'the host stays').toBeTruthy();
    await expect.soft(confirm.getByRole('button', { name: 'Try again' }), 'and the confirm offers to try again').toBeVisible();
    await audit(page, 'a refused removal');
  } finally {
    app.rt.remote.stopping.delete('tu_check');
    fake.noToken.delete(id);
  }
}

/** The host and its token stay, and the confirm says what to do. @param {import('@playwright/test').Page} page @param {string} id @param {import('@playwright/test').Locator} confirm */
async function refusedUnreached(page, id, confirm) {
  const away = failure('unreachable', NAME);
  fake.removeError = Object.assign(away, { next: `${away.next} Then remove it again.` });
  allowPageError(page, /status of 409/);
  await confirm.getByRole('button', { name: 'Try again' }).click();
  const why = confirm.getByRole('alert');
  await expect(why.locator('.ho-remove-next'), 'the next step').toBeVisible();
  await expect
    .soft(why, 'a 409 for a host that can’t be reached shows its message')
    .toContainText(
      new RegExp(`Postbox couldn’t reach ${escapeRegExp(NAME)}\\..*Postbox keeps ${escapeRegExp(NAME)} and its token here until it can remove itself there\\.`),
    );
  await expect.soft(why.locator('.ho-remove-next'), 'and its next step').toContainText('Then remove it again.');
  expect.soft(app.store.state.hosts[id], 'the host stays').toBeTruthy();
  expect
    .soft(
      fake.calls.filter((c) => c[0] === 'forget'),
      'and its token',
    )
    .toEqual([]);
  await expect.soft(confirm.getByRole('button', { name: 'Try again' }), 'and the confirm offers to try again').toBeVisible();
  await audit(page, 'a removal the host didn’t confirm');
}

/** @param {import('@playwright/test').Page} page @param {string} id @param {import('@playwright/test').Locator} confirm */
async function removed(page, id, confirm) {
  fake.removeError = null;
  await confirm.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => app.store.state.hosts[id], { message: 'then it’s removed' }).toBeUndefined();
  const order = fake.calls.filter((c) => c[1] === id && (c[0] === 'removeFromHost' || c[0] === 'forget')).map((c) => c[0]);
  expect.soft(order, 'removed there, and only then does the manager forget it').toEqual(['removeFromHost', 'removeFromHost', 'forget']);
  await expect(card(page, NAME), 'its card goes').toHaveCount(0);
  const add = page.getByRole('region', { name: 'Add a host' }).getByRole('textbox', { name: 'SSH destination' });
  await expect.soft(add, 'focus goes to Add a host, not the page’s body').toBeFocused();
  await expect.soft(page.getByRole('dialog', { name: 'Settings' }).getByText('No hosts yet.'), 'and the tab says there are none').toBeVisible();
}
