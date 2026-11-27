// #1958: the host daemon’s refusal to hello is quoted in the connection’s failure. It’s another program’s words, so
// it’s cleaned as tokenOutcome cleans the same kind of refusal (#1938): no character that hides or reorders text, no
// control character, and never half a character.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRefusal } from '../server/remote/ssh-failures.mjs';

test('#1958 a daemon’s refusal quoted in a connection failure is cleaned', () => {
  const f = classifyRefusal('h', { code: 'busy', message: 'busy: ‮esle‬ ​someone\u0007 holds it\uD800' });
  assert.match(f.message, /The host’s daemon said: “busy: esle someone holds it”/);
  assert.doesNotMatch(f.message, /[‪-‮⁦-⁩​-‏]|\p{Cc}|\p{Cs}/u);
});
