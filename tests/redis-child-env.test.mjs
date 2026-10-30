// The store’s Redis child gets only PATH, HOME and TMPDIR (server/redis-private.mjs, childEnv): nothing of Postbox’s
// own environment, which holds its secrets and whatever the person’s shell exported (#553’s review, hardening).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childEnv } from '../server/redis-private.mjs';

test('the child’s environment is PATH, HOME and TMPDIR, where set, and nothing else', () => {
  assert.deepEqual(childEnv({ PATH: '/usr/bin', HOME: '/Users/me', TMPDIR: '/tmp/x', POSTBOX_TOKEN: 's3cret', ANTHROPIC_API_KEY: 'k', SHELL: '/bin/zsh' }), {
    PATH: '/usr/bin',
    HOME: '/Users/me',
    TMPDIR: '/tmp/x',
  });
  assert.deepEqual(childEnv({ PATH: '/usr/bin' }), { PATH: '/usr/bin' }, 'an unset one isn’t passed as “undefined”');
});
