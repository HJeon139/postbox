// Checks the Hosts tab of Settings (#120) in headless Chrome: adding a host, a refused destination with the server’s
// own message, editing its settings and a project’s folder there, its status as the host manager reports it (a
// failed sign-in with the command to run, a host key, another Postbox driving it with Take over and its confirm, the
// daemon’s findings with the linger warning and where it looked for a missing harness), installing with
// describeInstall’s exact text first, a failed install’s next step, and removing a host: the confirm saying it
// removes Postbox from the host (or, with no token here, only forgets it), refused with a 409 that names the turn it
// can’t stop, refused again when the host can’t be reached, with the next step, then removed. Each step is checked at
// 375 and 1280 px, with axe.
//
//   node tools/check-hosts.mjs
//
// It starts its own fresh Postbox (demo mode) with a fake host manager in place of server/remote/hosts.mjs, so
// nothing connects to a host: the check sets each status the manager would report, and records what the page asks
// of it. PB_PORT and PB_CHROME_PORT move the ports (4500 and 9700 by default). It reports through tools/harness.mjs.

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { describeInstall, installOutcome } from '../server/remote/install.mjs';
import { classifyExit, failure } from '../server/remote/ssh.mjs';
import { checkDestination, checkHostPath } from '../shared/remote-settings.mjs';
import { launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4500, 9700);
const VERSION = '0.18.0';
const MINUTE = 60_000;
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-hosts-'));

/** The host manager’s shape, as the runtime uses it, with each status set by the check. */
class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** @type {any[]} */
    this.calls = [];
    /** @type {Map<string, any>} */
    this.statuses = new Map();
    /** @type {Error | null} */
    this.installError = null;
    /** Hosts this computer has no token for. @type {Set<string>} */
    this.noToken = new Set();
    /** What removeFromHost rejects with, in place of the daemon’s `removed`. @type {Error | null} */
    this.removeError = null;
  }
  /** Sets a host’s status and says so, as the manager does at each change. @param {string} id @param {any} status */
  set(id, status) {
    this.statuses.set(id, { failure: null, welcome: null, lastHeard: null, ...status });
    this.emit('status', id, this.statuses.get(id));
  }
  status(id) {
    return this.statuses.get(id) ?? null;
  }
  link(id) {
    if (this.noToken.has(id)) throw Object.assign(failure('not-installed', app.store.state.hosts[id].name), { code: 'not-installed' });
    return Object.assign(new EventEmitter(), { connected: false, send: () => false, retry: (o) => this.calls.push(['retry', id, o]) });
  }
  describeInstall(id) {
    return describeInstall(app.store.state.hosts[id], { version: VERSION, dataDir });
  }
  async install(id) {
    this.calls.push(['install', id]);
    if (this.installError) throw this.installError;
    return { token: 'T'.repeat(43), installed: true, version: VERSION };
  }
  async forget(id) {
    this.calls.push(['forget', id]);
    return true;
  }
  async removeFromHost(id) {
    this.calls.push(['removeFromHost', id]);
    if (this.noToken.has(id)) throw Object.assign(failure('not-installed', app.store.state.hosts[id].name), { code: 'not-installed' });
    if (this.removeError) throw this.removeError;
  }
  async refresh() {
    return false;
  }
  wake() {}
  need() {}
  release() {}
  async ensureWelcome() {
    throw failure('unreachable', 'host.example.com');
  }
  async signInCheck() {
    return null;
  }
  close() {}
}

const fake = new FakeHosts();
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome: dataDir, hosts: fake });

// axe, as tools/shoot-app.mjs runs it: WCAG 2.1 A and AA.
const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8').catch(() => null);
const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
  .then((r) => r.violations.map((v) => v.id + ' (' + v.impact + '): ' + v.help + ' at ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')))`;

/** @type {any} */
let page = null;
try {
  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900);
  await page.goto(`${app.origin}/`);
  await page.waitFor(`!!document.querySelector('.app')`, { label: 'the app' });
  if (AXE) await page.evaluate(`${AXE};0`);
  else check(false, 'axe-core is installed', 'Run npm install.');

  const js = JSON.stringify;
  const q = (sel) => `document.querySelector(${js(sel)})`;
  const text = (sel) => page.evaluate(`${q(sel)}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
  const click = (sel) => page.evaluate(`(${q(sel)}).click()`);
  /** Types into a field as a person would: its value, then input and change. */
  const type = (sel, value) =>
    page.evaluate(`(() => { const el = ${q(sel)}; el.focus(); el.value = ${js(value)};
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const waitFor = (expr, label) => page.waitFor(expr, { label });
  const until = async (fn, ms = 4000) => {
    for (let t = 0; t < ms && !fn(); t += 50) await sleep(50);
    return fn();
  };
  /** What a dialog on top says, and whether it fits the window. */
  const top = () =>
    page.evaluate(`(() => { const d = [...document.querySelectorAll('.dialog')].at(-1); if (!d) return null; const r = d.getBoundingClientRect();
      return { title: d.querySelector('.title')?.textContent ?? '', text: d.textContent.replace(/\\s+/g, ' '), role: d.getAttribute('role'), fits: r.left >= 0 && r.right <= innerWidth + 1 }; })()`);
  /** axe, and nothing wider than the window, at both widths; back at 1280 after. */
  const audit = async (label) => {
    for (const [w, ht] of [
      [375, 812],
      [1280, 900],
    ]) {
      await page.size(w, ht);
      await sleep(250);
      const wide = await page.evaluate(
        `[...document.querySelectorAll('.dialog *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && el.offsetParent !== null).map((el) => el.tagName + '.' + el.className).slice(0, 3)`,
      );
      check(!wide.length, `${label}: nothing runs off the window at ${w} px`, wide.join(', '));
      if (AXE) {
        const v = await page.evaluate(AXE_RUN);
        check(!v.length, `${label}: no axe violations at ${w} px`, v.join('\n'));
      }
    }
  };

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

  // ── A failed sign-in, and a host key ──
  const signIn = classifyExit({
    destination: 'build.example.com',
    code: 255,
    signal: null,
    stderr: 'user@build.example.com: Permission denied (publickey,gssapi-with-mic).\n',
  });
  fake.set(id, {
    state: 'failed',
    failure: { kind: signIn.kind, message: signIn.message, next: signIn.next, retry: false },
    lastHeard: Date.now() - 3 * MINUTE,
  });
  await waitFor(`!!document.querySelector('[data-host="${id}"] .ho-failure[data-kind="sign-in"]')`, 'the sign-in failure');
  const card = (await text(`[data-host="${id}"]`)) ?? '';
  check(card.includes(signIn.message) && /Last heard from 3 min ago/.test(card), 'a failed sign-in shows its message, and when it was last heard from', card);
  check(
    (await text(`[data-host="${id}"] .ho-cmd code`)) === 'ssh build.example.com' &&
      (await page.evaluate(`!!document.querySelector('[data-host="${id}"] .ho-cmd button[aria-label="Copy ssh build.example.com"]')`)),
    'it shows the command to run in a terminal, with Copy',
  );
  await click(`#ho-${id}-retry`);
  await until(() => fake.calls.some((c) => c[0] === 'retry'));
  check(
    JSON.stringify(fake.calls.find((c) => c[0] === 'retry')) === JSON.stringify(['retry', id, { takeover: false }]),
    'Reconnect retries, without taking over',
  );
  await audit('a failed sign-in');

  const key = classifyExit({
    destination: 'build.example.com',
    code: 255,
    signal: null,
    stderr:
      '@@@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nOffending ECDSA key in /home/user/.ssh/known_hosts:12\nHost key verification failed.\n',
  });
  fake.set(id, { state: 'failed', failure: { kind: key.kind, message: key.message, next: key.next, retry: false } });
  await waitFor(`!!document.querySelector('[data-host="${id}"] .ho-failure[data-kind="host-key"]')`, 'the host key failure');
  const cmds = await page.evaluate(`[...document.querySelectorAll('[data-host="${id}"] .ho-cmd code')].map((c) => c.textContent)`);
  check(js(cmds) === js(['ssh-keygen -R build.example.com', 'ssh build.example.com']), 'a changed host key shows both commands, in order', js(cmds));

  // ── Another Postbox drives it ──
  const busy = failure('busy', 'build.example.com', { why: 'The host’s daemon said: “Another Postbox is attached.”' });
  fake.set(id, { state: 'failed', failure: { kind: 'busy', message: busy.message, next: busy.next, retry: false } });
  await waitFor(`!!document.getElementById('ho-${id}-takeover')`, 'Take over');
  await click(`#ho-${id}-takeover`);
  await waitFor(`/Take over/.test([...document.querySelectorAll('.dialog')].at(-1)?.textContent ?? '')`, 'the takeover confirm');
  const take = await top();
  check(
    take?.role === 'alertdialog' &&
      /Another Postbox is connected to build\.example\.com and driving it/.test(take.text) &&
      /Turns already running there keep running/.test(take.text),
    'Take over asks first, saying another Postbox is driving the host',
    take?.text,
  );
  check(!fake.calls.some((c) => c[0] === 'retry' && c[2].takeover), 'asking takes nothing over');
  await audit('the takeover confirm');
  await click('#ho-takeover-go');
  await until(() => fake.calls.some((c) => c[0] === 'retry' && c[2].takeover));
  check(
    fake.calls.some((c) => c[0] === 'retry' && c[1] === id && c[2].takeover === true),
    'Take over retries with takeover: true',
  );
  await waitFor(`!document.getElementById('ho-takeover-go')`, 'the confirm to close');

  // ── What the daemon found ──
  fake.set(id, {
    state: 'connected',
    lastHeard: Date.now(),
    welcome: {
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
    },
  });
  await waitFor(`!!document.querySelector('[data-host="${id}"] .ho-problem[data-code="no-linger"]')`, 'the linger warning');
  const linger = (await text(`[data-host="${id}"] .ho-problem`)) ?? '';
  check(
    /Turns on build\.example\.com end when your last session there does/.test(linger) &&
      (await text(`[data-host="${id}"] .ho-problem .ho-cmd code`)) === 'loginctl enable-linger',
    'the linger warning says turns end with your last session, and how to turn lingering on',
    linger,
  );
  const found = (await text(`[data-host="${id}"] .ho-found`)) ?? '';
  check(/v22\.11\.0 at \/usr\/bin\/node/.test(found), 'it shows Node’s version and path', found);
  check(
    /Kiro CLI\s*Not found\. The daemon looked in \/home\/user\/\.local\/bin\/kiro-cli, \/usr\/local\/bin\/kiro-cli/.test(found),
    'a missing harness says where the daemon looked',
    found,
  );
  check(/Connected/.test((await text(`[data-host="${id}"] .status-tag`)) ?? ''), 'connected says so');
  await audit('a connected host with warnings');

  // ── Removing: refused while a turn there can’t be stopped, then while the host can’t be reached, then removed ──
  // With no token here, Postbox can only forget the host, and the confirm says so.
  const was = fake.statuses.get(id);
  fake.set(id, { state: 'not-installed' });
  await waitFor(`/Not installed/i.test(document.querySelector('[data-host="${id}"] .status-tag')?.textContent ?? '')`, 'not installed');
  await click(`#ho-${id}-remove`);
  await waitFor(`!!document.getElementById('ho-remove-go')`, 'the remove confirm');
  const local = await top();
  check(
    /This computer has no token for build\.example\.com, so Postbox can’t reach anything of its own there\. It forgets the host here/.test(local?.text ?? '') &&
      !/deletes ~\/\.postbox-remote/.test(local?.text ?? '') &&
      (await text('#ho-remove-go')) === 'Remove host',
    'with no token here, the confirm says Postbox only forgets the host',
    local?.text,
  );
  await audit('removing a host with no token here');
  await page.evaluate(`[...document.querySelectorAll('.dialog')].at(-1).querySelector('.d-foot .btn:not(.danger)').click()`);
  await waitFor(`!document.getElementById('ho-remove-go')`, 'the confirm to close');
  fake.set(id, was);
  await waitFor(`/Connected/.test(document.querySelector('[data-host="${id}"] .status-tag')?.textContent ?? '')`, 'connected again');

  const se = Object.values(app.store.state.sessions)[0];
  app.rt.remote.stopping.set('tu_check', /** @type {any} */ ({ hostId: id, sessionId: se?.id ?? '', waiters: [] }));
  fake.noToken.add(id);
  await click(`#ho-${id}-remove`);
  await waitFor(`!!document.getElementById('ho-remove-go')`, 'the remove confirm');
  const rm1 = await top();
  check(
    rm1?.role === 'alertdialog' &&
      rm1.title === 'Remove build.example.com?' &&
      /Postbox stops the daemon and every turn still running on build\.example\.com, and deletes ~\/\.postbox-remote there: its code, token, logs and turn records\. Then it forgets the host here/.test(
        rm1.text,
      ),
    'Remove asks first, saying it stops the daemon and its turns there and deletes ~/.postbox-remote, then forgets the host',
    rm1?.text,
  );
  check((await text('#ho-remove-go')) === 'Remove Postbox from build.example.com', 'the confirm’s action names it: Remove Postbox from the host');
  await audit('the remove confirm');
  await click('#ho-remove-go');
  await waitFor(`!!document.querySelector('.ho-remove-result .callout')`, 'the refusal');
  const why = (await text('.ho-remove-result')) ?? '';
  check(
    /token isn’t on this computer any more, so Postbox can’t reach it to stop 1 running turn/.test(why) && why.includes(se ? `@${se.handle}` : 'an agent'),
    'a 409 shows its message, naming the turn it can’t stop',
    why,
  );
  check(!!app.store.state.hosts[id] && (await text('#ho-remove-go')) === 'Try again', 'the host stays, and the confirm offers to try again');
  await audit('a refused removal');
  app.rt.remote.stopping.delete('tu_check');
  fake.noToken.delete(id);
  // The host can’t be reached to remove Postbox there: the host and its token stay, and the confirm says what to do.
  const away = failure('unreachable', 'build.example.com');
  fake.removeError = Object.assign(away, { next: `${away.next} Then remove it again.` });
  await click('#ho-remove-go');
  await waitFor(`!!document.querySelector('.ho-remove-result .ho-remove-next')`, 'the next step');
  const unreached = (await text('.ho-remove-result')) ?? '';
  check(
    /Postbox couldn’t reach build\.example\.com\..*Postbox keeps build\.example\.com and its token here until it can remove itself there\./.test(unreached) &&
      /Then remove it again\./.test((await text('.ho-remove-next')) ?? ''),
    'a 409 for a host that can’t be reached shows its message and next step',
    unreached,
  );
  check(
    !!app.store.state.hosts[id] && !fake.calls.some((c) => c[0] === 'forget' && c[1] === id) && (await text('#ho-remove-go')) === 'Try again',
    'the host and its token stay, and the confirm offers to try again',
  );
  await audit('a removal the host didn’t confirm');
  fake.removeError = null;
  await click('#ho-remove-go');
  await until(() => !app.store.state.hosts[id]);
  const order = fake.calls.filter((c) => c[1] === id && (c[0] === 'removeFromHost' || c[0] === 'forget')).map((c) => c[0]);
  check(
    !app.store.state.hosts[id] && order.join(',') === 'removeFromHost,removeFromHost,forget',
    'then it’s removed there, and only then does the manager forget it',
    order.join(','),
  );
  await waitFor(`!document.querySelector('[data-host="${id}"]')`, 'its card to go');
  check(/No hosts yet/.test((await text('.hosts')) ?? ''), 'and the tab says there are none');

  // The failed install (502) and the refused removal (409) were asked for.
  const errors = page.logs.filter((l) => !/api\/stream|ERR_INCOMPLETE_CHUNKED|status of (?:502|409) .*\/api\/hosts\//.test(l));
  check(!errors.length, 'no errors in the browser console', errors.join('\n'));
} catch (e) {
  check(false, 'the check ran to the end', e.stack ?? e.message);
} finally {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
finish();
