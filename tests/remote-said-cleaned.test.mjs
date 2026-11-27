// #1938: what a host or ssh said reaches a remote host’s error quoted. It can carry a ProxyCommand’s, a bastion’s, a
// host banner’s or the install script’s words, so it’s cleaned as a program’s words are: no character that hides or
// reorders text, no control character, and never half a character.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installOutcome, tokenOutcome } from '../server/remote/install.mjs';
import { classifyExit } from '../server/remote/ssh.mjs';

const HIDDEN = /[‪-‮⁦-⁩​-‏]|\p{Cc}|\p{Cs}/u;
const SAID = 'banner: ‮detaf‬ ​the \u0007host\uD800 is down';

function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return /** @type {Error} */ (e).message;
  }
  assert.fail('it threw');
}

test('#1938 ssh’s stderr quoted in a connection failure is cleaned', () => {
  const said = thrown(() => {
    throw classifyExit({ destination: 'h', code: 255, signal: null, stderr: `${SAID}\n` });
  });
  assert.match(said, /banner: detaf the host is down/);
  assert.doesNotMatch(said, HIDDEN);
});

test('#1938 what the host said when an install or its token run failed is cleaned', () => {
  const ran = (/** @type {any} */ r) => ({ code: 1, signal: null, stdout: '', stderr: '', ...r });
  for (const [what, said] of [
    ['the host’s answer', thrown(() => installOutcome('h', '1.0.0', ran({ code: 0, stdout: SAID })))],
    ['the install’s last line', thrown(() => installOutcome('h', '1.0.0', ran({ stderr: SAID })))],
    ['the install’s known exit 66', thrown(() => installOutcome('h', '1.0.0', ran({ code: 66, stderr: SAID })))],
    ['the token run’s last line', thrown(() => tokenOutcome('h', ran({ stderr: SAID })))],
    ['the host program’s refusal', thrown(() => tokenOutcome('h', ran({ stdout: JSON.stringify({ type: 'error', code: 'x', message: SAID }) })))],
  ]) {
    assert.match(said, /banner: detaf the host is down/, what);
    assert.doesNotMatch(said, HIDDEN, what);
  }
});
