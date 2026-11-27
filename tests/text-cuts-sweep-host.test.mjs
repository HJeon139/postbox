// #1686, the reopened sweep: what a remote host and its install say, which the person reads in Settings or a failed
// install and Postbox passes on, cut by length only at a whole character (cutText). Each case puts an emoji across its
// site’s cut. A line the daemon sends is JSON, which writes a lone half of a pair as its escape, so those cases look
// for the escape.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { forget } from '../server/remote/host/daemon-forget.mjs';
import { welcomeLoginPath } from '../server/remote/host/daemon-login.mjs';
import { fail } from '../server/remote/host/daemon-reply.mjs';
import { findPrograms } from '../server/remote/host/programs.mjs';
import { installOutcome, tokenOutcome } from '../server/remote/install.mjs';
import { REMOTE_LIMITS } from '../shared/remote-protocol.mjs';
import { tempDir } from './temp-dirs.mjs';
import { across, whole } from './text-cuts-fixture.mjs';

/** A connection that keeps the lines the daemon writes to it. */
function conn() {
  /** @type {string[]} */
  const lines = [];
  return { lines, c: /** @type {any} */ ({ closed: false, output: { write: (/** @type {string} */ l) => lines.push(l) > 0 } }) };
}
/** Fails when a line the daemon wrote holds the escape of a lone half. @param {string[]} lines @param {string} where */
function wholeLines(lines, where) {
  assert.ok(lines.length > 0 && lines.every((l) => l.includes('xxxx')), `${where} wasn’t sent`);
  for (const l of lines) assert.doesNotMatch(l, /\\ud[89ab]/i, `${where} ends inside a character`);
}

/** The message an install outcome throws. @param {() => unknown} fn */
function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return /** @type {Error} */ (e).message;
  }
  assert.fail('it threw');
}

test('#1686 what the host said when an install or its token run failed is quoted whole', () => {
  const ran = (/** @type {any} */ r) => ({ code: 1, signal: null, stdout: '', stderr: '', ...r });
  whole(
    thrown(() => installOutcome('h', '1.0.0', ran({ code: 0, stdout: across(200) }))),
    'the host’s answer',
  );
  whole(
    thrown(() => installOutcome('h', '1.0.0', ran({ code: 1, stderr: across(300) }))),
    'the install’s last line',
  );
  whole(
    thrown(() => tokenOutcome('h', ran({ code: 1, stderr: across(300) }))),
    'the token run’s last line',
  );
});

test('#1686 a refusal the daemon sends, and why it couldn’t forget an agent’s memory, are cut whole', async () => {
  const sent = conn();
  fail(sent.c, 'internal', across(REMOTE_LIMITS.messageChars), 'hello');
  wholeLines(sent.lines, 'the refusal');
  // A root too long for the file system: reading it fails, and the refusal quotes it.
  const head = 'The daemon couldn’t read ';
  const forgot = conn();
  await forget(/** @type {any} */ ({ p: { root: across(REMOTE_LIMITS.messageChars - head.length) }, log: () => {} }), forgot.c, { persona: 'pe_1' });
  wholeLines(forgot.lines, 'the forget refusal');
});

test('#1686 why the login shell’s PATH wasn’t read, and a CLI’s failed --version, are cut whole', async () => {
  whole(welcomeLoginPath(/** @type {any} */ ({ loginPath: { ok: false, why: across(REMOTE_LIMITS.messageChars) } })).why, 'why');
  const found = await findPrograms({
    home: tempDir('pb-cuts-host-'),
    settings: { claudePath: join('/', 'opt', 'claude') },
    env: { PATH: '' },
    execFile: /** @type {any} */ ((_p, _a, _o, done) => done(new Error(across(500)))),
    isExecutable: async () => true,
    listDir: async () => [],
    nodeVersion: 'v22.0.0',
  });
  const failed = found.problems.find((p) => p.code === 'version-failed');
  whole(failed?.message, 'the --version failure');
});
