// Checks the Hosts tab of Settings (#120) in headless Chrome: adding a host, a refused destination with the server’s
// own message, installing with describeInstall’s exact text first, a failed install’s next step, and editing its
// settings and a project’s folder there. Each step is checked at 375 and 1280 px, with axe. Its status as the host
// manager reports it, and removing a host, are tools/check-hosts-status.mjs; a host just added, with the real
// manager, is tools/check-hosts-add.mjs.
//
//   node tools/check-hosts.mjs
//
// It starts its own fresh Postbox (demo mode) with a fake host manager, as tools/hosts-check.mjs sets them up, so
// nothing connects to a host. PB_PORT and PB_CHROME_PORT move the ports (4500 and 9700 by default). It reports
// through tools/harness.mjs.

import { describeInstall, installOutcome } from '../server/remote/install.mjs';
import { checkDestination, checkHostPath } from '../shared/remote-settings.mjs';
import { record as check } from './harness.mjs';
import { app, audit, begin, click, consoleClean, dataDir, end, fake, MINUTE, page, text, top, type, until, VERSION, waitFor } from './hosts-check.mjs';

try {
  await begin();

  // ── The tab, and adding ──
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts'))`);
  await waitFor(`!!document.getElementById('ho-add')`, 'the Hosts tab');
  check((await text('.dialog [role=tab][aria-selected=true]')) === 'Hosts', 'Settings has a Hosts tab');
  check(/No hosts yet/.test((await text('.hosts')) ?? ''), 'with no hosts, it says so');

  const refused = '-oProxyCommand=x';
  await type('#ho-add', refused);
  await click('#ho-add-btn');
  await waitFor(`!document.getElementById('ho-add-err').hidden`, 'the refusal');
  const said = await text('#ho-add-err');
  check(
    said === /** @type {any} */ (checkDestination(refused)).error,
    'a destination ssh would read as an option is refused with the shared check’s message',
    said,
  );
  check(
    (await page.evaluate(`document.getElementById('ho-add').getAttribute('aria-invalid')`)) === 'true' && !Object.keys(app.store.state.hosts).length,
    'the field is marked invalid, and nothing was added',
  );

  await type('#ho-add', 'build.example.com');
  await click('#ho-add-btn');
  await until(() => Object.keys(app.store.state.hosts).length === 1);
  const host = Object.values(app.store.state.hosts)[0];
  const id = host?.id;
  check(host?.name === 'build.example.com', 'Add host adds it', JSON.stringify(host));
  await waitFor(`!!document.querySelector('[data-host="${id}"]')`, 'its card');

  // Not installed: the action is Install, which asks first.
  fake.set(id, { state: 'not-installed' });
  await waitFor(`!!document.getElementById('ho-${id}-install')`, 'Install');
  check(/Not installed/.test((await text(`[data-host="${id}"] .status-tag`)) ?? ''), 'a host not installed says so');
  await audit('the Hosts tab');

  // ── Installing ──
  await click(`#ho-${id}-install`);
  await waitFor(`!!document.querySelector('.ho-install-text')`, 'the install confirm');
  const expected = describeInstall(app.store.state.hosts[id], { version: VERSION, dataDir }).text;
  const shownText = await page.evaluate(`document.querySelector('.ho-install-text').textContent`);
  check(shownText === expected, 'the install confirm shows describeInstall’s text exactly', shownText);
  const confirm = await top();
  check(
    confirm?.role === 'alertdialog' && confirm.title === 'Install Postbox on build.example.com?',
    'it asks, as an alert dialog',
    JSON.stringify(confirm?.title),
  );
  check(!fake.calls.some((c) => c[0] === 'install'), 'reading what it does installs nothing');
  await audit('the install confirm');

  // A failed install shows its message and next step, and offers to install again: not “tries again on its own”.
  try {
    installOutcome('build.example.com', VERSION, { code: 1, signal: null, stdout: '', stderr: 'mkdir: cannot create directory: No space left on device\n' });
  } catch (e) {
    fake.installError = e;
  }
  await click('#ho-install-go');
  await waitFor(`!!document.querySelector('.ho-install-result .callout')`, 'the failure');
  const failed = (await text('.ho-install-result')) ?? '';
  const ie = /** @type {any} */ (fake.installError);
  check(failed.includes(ie.message) && failed.includes(ie.next.replace(/`/g, '')), 'a failed install shows its message and next step', failed);
  check(!/tries again on its own/.test(failed), 'a failed install doesn’t say Postbox tries again on its own', failed);
  check((await text('#ho-install-go')) === 'Install again', 'and offers Install again');
  await audit('a failed install');
  fake.installError = null;
  await click('#ho-install-go');
  await until(() => fake.calls.filter((c) => c[0] === 'install').length === 2);
  await waitFor(`!document.querySelector('.ho-install-text')`, 'the confirm to close');
  check(/Installed Postbox on build\.example\.com/.test((await text('#toasts')) ?? ''), 'an install that works says so');

  // ── Editing ──
  fake.set(id, { state: 'disconnected' });
  await click(`#ho-${id}-edit`);
  await waitFor(`!!document.getElementById('ho-${id}-stallTimeout')`, 'the editor');
  const fieldsShown = await page.evaluate(
    `['name','stallTimeout','permissionWaitMax','idleTimeout','logRetention','logMaxBytes','keepAlive-interval','keepAlive-count','dedicatedConnection','forwardAgent','denyPrompts','nodePath','claudePath','kiroPath','codexPath','detach','signInCheck']
      .filter((k) => !document.getElementById('ho-${id}-' + k))`,
  );
  check(!fieldsShown.length, 'the editor has every setting in the design’s table', `missing: ${fieldsShown.join(', ')}`);
  check(
    (await text(`label[for="ho-${id}-stallTimeout"]`)) === 'Stop a quiet turn after' &&
      (await page.evaluate(`document.getElementById('ho-${id}-stallTimeout').value + ' ' + document.getElementById('ho-${id}-stallTimeout-unit').value`)) ===
        '15 min',
    'stallTimeout shows 15 min, with its unit',
  );
  check(
    (await text(`#ho-${id}-denyPrompts`)) === 'Deny permission prompts instead of waiting (unattended runs)' &&
      (await page.evaluate(`document.getElementById('ho-${id}-denyPrompts').getAttribute('aria-checked')`)) === 'false',
    'denyPrompts is there, off by default, in D2’s words',
  );
  check(
    /one argument per line, run without a shell/.test((await text(`#ho-${id}-signInCheck-help`)) ?? ''),
    'signInCheck is an argument list, never a shell string',
  );
  await audit('the editor');

  // Out of range: said in the unit you typed, and nothing is saved.
  await type(`#ho-${id}-stallTimeout`, '5');
  await waitFor(`!document.getElementById('ho-${id}-stallTimeout-err').hidden`, 'the range error');
  check(
    (await text(`#ho-${id}-stallTimeout-err`)) === 'Stop a quiet turn after must be 10 min to 24 h.',
    'a value out of range says the range',
    await text(`#ho-${id}-stallTimeout-err`),
  );
  const project = Object.values(app.store.state.projects)[0];
  await type(`#ho-${id}-pf-${project.id}`, 'app');
  const relative = /** @type {any} */ (checkHostPath('app', 'The project’s folder on build.example.com')).error;
  check((await text(`#ho-${id}-pf-${project.id}-err`)) === relative, 'a project folder that isn’t absolute is refused with the shared check’s message');
  await click(`#ho-${id}-save`);
  await waitFor(`!document.getElementById('ho-${id}-form-err').hidden`, 'the form’s refusal');
  check(app.store.state.hosts[id].settings.stallTimeout === 15 * MINUTE, 'Save refuses while a field is wrong, and says so', await text(`#ho-${id}-form-err`));

  await type(`#ho-${id}-stallTimeout`, '20');
  await type(`#ho-${id}-pf-${project.id}`, '/home/user/app');
  await type(`#ho-${id}-signInCheck`, 'klist\n-s');
  await click(`#ho-${id}-denyPrompts`);
  await click(`#ho-${id}-save`);
  await until(() => app.store.state.projects[project.id].hostFolders?.[id] === '/home/user/app');
  const saved = app.store.state.hosts[id].settings;
  check(saved.stallTimeout === 20 * MINUTE, 'Save stores a changed setting in its unit', String(saved.stallTimeout));
  check(
    saved.denyPrompts === true && JSON.stringify(saved.signInCheck) === '["klist","-s"]',
    'and denyPrompts, and signInCheck as an argument list',
    JSON.stringify(saved),
  );
  check(app.store.state.projects[project.id].hostFolders?.[id] === '/home/user/app', 'and the project’s folder on the host');
  await waitFor(`!document.getElementById('ho-${id}-stallTimeout')`, 'the editor to close');

  consoleClean();
} catch (e) {
  check(false, 'the check ran to the end', e.stack ?? e.message);
} finally {
  await end();
}
