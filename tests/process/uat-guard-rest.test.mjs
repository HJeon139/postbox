// #1125, the rest: ways the person's credentials still reached a UAT run's agents past the git guard, each probed with a
// made-up helper, askpass or .netrc that prints a fake secret, and each checked against the person's own git first.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { guardEnv } from '../../tools/uat/git-remote.mjs';
import { tempDir } from '../temp-dirs.mjs';

const SECRET = 'made-up-1125-secret';
const HELPER = `!f() { echo username=person; echo password=${SECRET}; }; f`;
const ASK = 'protocol=https\nhost=github.com\n\n';
/** A person's home with nothing in it, and git asked for a github.com password there. */
const person = () => ({ PATH: process.env.PATH, HOME: tempDir('postbox-uat-guard-rest-'), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
const fill = (env) => spawnSync('git', ['credential', 'fill'], { env, input: ASK, encoding: 'utf8', timeout: 20_000 }).stdout ?? '';

test('#1125: a helper named in an inherited GIT_CONFIG_PARAMETERS hands the guarded git nothing', () => {
  const theirs = { ...person(), GIT_CONFIG_PARAMETERS: `'credential.helper=${HELPER}'` };
  assert.match(fill(theirs), new RegExp(`password=${SECRET}`), 'the control: the person’s own git gets it');
  assert.doesNotMatch(fill({ ...theirs, ...guardEnv() }), /password=/);
});
