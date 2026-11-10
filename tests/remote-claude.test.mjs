// shared/remote-claude.mjs: which claude a remote turn runs on, and the words for one it can’t (C3, D2). The laptop
// says them from its cached welcome, and the host’s daemon from the claude it finds at the start (#1084), so the person
// sees the same refusal from either side.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DENY_PROMPTS_MIN as ADAPTER_DENY_MIN, REMOTE_CLAUDE_MIN as ADAPTER_MIN } from '../server/adapters/claude-code.mjs';
import { claudeNeed, claudeProblem, DENY_PROMPTS_MIN, NO_WELCOME_YET, REMOTE_CLAUDE_MIN } from '../shared/remote-claude.mjs';
import { welcomeWith } from './claude-code-remote-fixture.mjs';

const harness = (welcome) => welcome.harnesses[0];

test('#1084: a claude that’s missing, too old or of no known version is refused, saying what was found and where', () => {
  assert.match(
    claudeProblem(harness(welcomeWith({ path: null })), claudeNeed()) ?? '',
    /^Claude Code isn’t installed on the host\. It looked in \/home\/user\/\.local\/bin, \/usr\/local\/bin\. Install it there, or set claudePath/,
  );
  assert.match(
    claudeProblem(harness(welcomeWith({ version: '2.1.186' })), claudeNeed()) ?? '',
    /^Claude Code 2\.1\.186 at \/home\/user\/\.local\/bin\/claude on the host is older than 2\.1\.187, which remote turns need\. Update it there with claude update\.$/,
  );
  assert.match(
    claudeProblem(harness(welcomeWith({ version: '2.1.258' })), claudeNeed({ denyPrompts: true })) ?? '',
    /2\.1\.258 at \/home\/user\/\.local\/bin\/claude .*older than 2\.1\.259, which turning off permission prompts \(denyPrompts\) needs/,
  );
  assert.match(
    claudeProblem(harness(welcomeWith({ version: 'nightly' })), claudeNeed()) ?? '',
    /couldn’t tell the version of Claude Code at \/home\/user\/\.local\/bin\/claude on the host \(it said “nightly”\)\. It needs 2\.1\.187 or later/,
  );
  assert.equal(claudeProblem(harness(welcomeWith({ version: '2.1.187' })), claudeNeed()), null);
  assert.equal(claudeProblem(harness(welcomeWith({ version: '2.1.308.1314' })), claudeNeed({ denyPrompts: true })), null);
});

test('#1084: the need a start carries is the denyPrompts minimum with denyPrompts on, else the remote one', () => {
  assert.deepEqual(claudeNeed(), { min: REMOTE_CLAUDE_MIN, why: 'remote' });
  assert.deepEqual(claudeNeed({ denyPrompts: false }), { min: '2.1.187', why: 'remote' });
  assert.deepEqual(claudeNeed({ denyPrompts: true }), { min: DENY_PROMPTS_MIN, why: 'denyPrompts' });
  assert.equal(DENY_PROMPTS_MIN, '2.1.259');
});

test('#1084: the adapter’s old names give the shared minimums, and a host not heard from yet has its own words', () => {
  assert.equal(ADAPTER_MIN, REMOTE_CLAUDE_MIN);
  assert.equal(ADAPTER_DENY_MIN, DENY_PROMPTS_MIN);
  assert.match(NO_WELCOME_YET, /hasn’t heard from the host’s daemon yet/);
});
