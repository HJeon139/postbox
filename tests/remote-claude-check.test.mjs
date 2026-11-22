// #1084: a claude installed on a host after Postbox connected is found on the next turn, with no daemon restart. A
// daemon that says it checks claude (welcome.claudeChecks) gets the turn’s start even when its welcome named no
// claude; it looks for one again, checks its version against the floor the start names, and refuses before it makes
// the turn’s folder. An older daemon, which would refuse the unknown field, keeps the laptop’s own refusal.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { PROTOCOL_VERSION, validateMessage } from '../shared/remote-protocol.mjs';
import { forbidden, remoteCtx, starts, welcomeWith } from './claude-code-remote-fixture.mjs';
import { createFakeDaemon, fixtureLines } from './fake-daemon.mjs';
import { fakeClock, hello, PROGRAMS_FOUND, setup, startMsg } from './remote-daemon-setup.mjs';

const adapter = () => new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });

test('#1084 the laptop lets a start through to a daemon that checks claude, naming the floor; an older daemon keeps its refusal', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const missing = welcomeWith({ path: null });
  await assert.rejects(adapter().deliver({}, { kind: 'user', text: 'Hi' }, remoteCtx(d, { welcome: missing })), /Claude Code isn’t installed on the host/);
  assert.equal(starts(d).length, 0, 'an older daemon: refused here, as before');
  await adapter().deliver({}, { kind: 'user', text: 'Hi' }, remoteCtx(d, { welcome: { ...missing, claudeChecks: true }, settings: { denyPrompts: true } }));
  assert.deepEqual(starts(d)[0].claudeCheck, { denyPrompts: true });
});

test('#1084 a start’s claudeCheck is for claude only, and a welcome may say the daemon checks', () => {
  assert.equal(validateMessage('postbox-to-daemon', { type: 'start', ...startMsg('t1'), claudeCheck: { denyPrompts: false } }).ok, true);
  const kiro = validateMessage('postbox-to-daemon', { type: 'start', ...startMsg('t1', { harness: 'kiro-cli' }), claudeCheck: { denyPrompts: false } });
  assert.equal(kiro.ok, false);
  const welcome = (/** @type {unknown} */ claudeChecks) =>
    validateMessage('daemon-to-postbox', {
      type: 'welcome',
      version: PROTOCOL_VERSION,
      home: '/home/user',
      node: { path: '/usr/bin/node', version: 'v22.12.0' },
      harnesses: [],
      problems: [],
      turns: [],
      claudeChecks,
    }).ok;
  assert.equal(welcome(true), true);
  assert.equal(welcome('yes'), false, 'only a boolean');
});

/** A findPrograms whose claude is `found` at each call, in turn: the last one stays. @param {any[]} found */
function programs(found) {
  return async () => {
    const all = structuredClone(PROGRAMS_FOUND);
    all.harnesses[0] = { name: 'claude-code', looked: ['/home/user/.local/bin/claude'], ...(found.length > 1 ? found.shift() : found[0]) };
    return all;
  };
}
const NONE = { path: null, version: null };
const AT = (version) => ({ path: '/home/user/.local/bin/claude', version });

test('#1084 the daemon says it checks claude, and finds one installed after an earlier look found none', async () => {
  const clock = fakeClock();
  const s = setup({ clock, probeLoginPath: async () => ({ ok: true, entries: ['/bin'], ms: 1 }), findPrograms: programs([NONE, NONE, AT('2.1.296')]) });
  try {
    const c = await hello(s);
    assert.equal(c.welcome.claudeChecks, true);
    c.send('start', startMsg('t1', { claudeCheck: { denyPrompts: false } }));
    const missing = await c.msgs.next('error');
    assert.equal(missing.code, 'no-harness', 'not installed yet: the look at the start finds none');
    assert.match(missing.message, /^Claude Code isn’t installed on the host\. .* Install it there, or set claudePath/, 'the laptop’s words');
    // It’s installed now. A while later, the next turn looks again and starts.
    await clock.tick(60_000);
    c.send('start', startMsg('t2', { claudeCheck: { denyPrompts: false } }));
    await c.msgs.next('started');
  } finally {
    await s.done();
  }
});

test('#1084 the daemon refuses a claude older than the start’s floor, before it makes the turn’s folder', async () => {
  for (const [version, denyPrompts, said] of [
    ['2.1.186', false, /older than 2\.1\.187, which remote turns need/],
    ['2.1.258', true, /older than 2\.1\.259, which turning off permission prompts/],
    ['nightly', false, /couldn’t tell the version of Claude Code/],
  ]) {
    const s = setup({ findPrograms: programs([AT(version)]) });
    try {
      const c = await hello(s);
      c.send('start', startMsg('t1', { claudeCheck: { denyPrompts } }));
      const e = await c.msgs.next('error');
      assert.match(e.message, said, version);
      assert.equal(existsSync(s.p.turn('t1')), false, 'no turn folder');
      // Without the check, the laptop already checked: the start goes on, as before.
      c.send('start', startMsg('t2'));
      await c.msgs.next('started');
    } finally {
      await s.done();
    }
  }
});

test('#1084 a claude updated since the last look is found, rather than refused as too old', async () => {
  const clock = fakeClock();
  const s = setup({ clock, findPrograms: programs([AT('2.1.186'), AT('2.1.296')]) });
  try {
    const c = await hello(s);
    await clock.tick(60_000);
    c.send('start', startMsg('t1', { claudeCheck: { denyPrompts: false } }));
    await c.msgs.next('started');
  } finally {
    await s.done();
  }
});
