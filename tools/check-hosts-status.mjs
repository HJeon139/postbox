// Checks a host’s status in the Hosts tab of Settings (#120) in headless Chrome, as the host manager reports it: a
// failed sign-in with the command to run, a host key, another Postbox driving it with Take over and its confirm, the
// daemon’s findings with the linger warning and where it looked for a missing harness; and removing a host: the
// confirm saying it removes Postbox from the host (or, with no token here, only forgets it), refused with a 409 that
// names the turn it can’t stop, refused again when the host can’t be reached, with the next step, then removed. Each
// step is checked at 375 and 1280 px, with axe. Adding, installing and editing a host are tools/check-hosts.mjs.
//
//   node tools/check-hosts-status.mjs
//
// It starts its own fresh Postbox (demo mode) with a fake host manager, as tools/hosts-check.mjs sets them up, and
// one host, build.example.com, so nothing connects to a host. PB_PORT and PB_CHROME_PORT move the ports (4500 and
// 9700 by default). It reports through tools/harness.mjs.

import { classifyExit, failure } from '../server/remote/ssh.mjs';
import { record as check } from './harness.mjs';
import { app, audit, begin, click, consoleClean, end, fake, js, MINUTE, page, text, top, until, waitFor } from './hosts-check.mjs';

// The host as Add host leaves it: tools/check-hosts.mjs checks adding, installing and editing it.
const id = app.rt.addHost({ name: 'build.example.com' }).id;

try {
  await begin();
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts'))`);
  await waitFor(`!!document.querySelector('[data-host="${id}"]')`, 'its card');

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
  await until(() => fake.calls.some((c) => c[0] === 'connect'));
  check(
    JSON.stringify(fake.calls.find((c) => c[0] === 'connect')) === JSON.stringify(['connect', id, { takeover: false }]),
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
  check(!fake.calls.some((c) => c[0] === 'connect' && c[2].takeover), 'asking takes nothing over');
  await audit('the takeover confirm');
  await click('#ho-takeover-go');
  await until(() => fake.calls.some((c) => c[0] === 'connect' && c[2].takeover));
  check(
    fake.calls.some((c) => c[0] === 'connect' && c[1] === id && c[2].takeover === true),
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
  check(
    /working folders there, such as ~\/postbox-work\/<handle>, stay\. Another Postbox that uses build\.example\.com loses its access too/.test(rm1?.text ?? ''),
    'it says what stays there, and that another Postbox using the host loses access',
    rm1?.text,
  );
  check((await page.evaluate('document.activeElement?.textContent?.trim()')) === 'Cancel', 'Cancel has focus first, not the button that deletes');
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
  check((await page.evaluate('document.activeElement?.id')) === 'ho-add', 'focus goes to Add a host, not the page’s body');
  check(/No hosts yet/.test((await text('.hosts')) ?? ''), 'and the tab says there are none');

  consoleClean();
} catch (e) {
  check(false, 'the check ran to the end', e.stack ?? e.message);
} finally {
  await end();
}
