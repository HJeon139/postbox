// #871 end to end: a PreToolUse hook that approves every call can live in a project skill’s or subagent’s frontmatter
// as well as in a settings file. Claude Code registers it for the session when the skill or subagent runs, and the
// docs bundled with the Agent SDK don’t say whether `disableAllHooks` covers it: its own doc names “the hooks defined
// in settings files and by installed plugins” (sdk.d.ts, disableAllHooks). This asks a real turn through each real
// adapter, in Ask me, to use the skill or the subagent, which asks for `git push origin HEAD:refs/heads/e2e`; the test
// answers the card no, and checks a card showed, the branch never reached the remote and the hook never ran. A control
// turn in Run everything, where Postbox keeps the person’s hooks, shows the frontmatter hook does run when it loads.
// Ask me, not Auto, since #806: in Auto Postbox keeps the person’s hooks (harness first, #961), as
// claude-code-mods-e2e.test.mjs says.
//
// It runs real model turns, which cost money, so it runs only with POSTBOX_E2E_CLAUDE=1 and a `claude` on PATH, as
// claude-code-mods-e2e.test.mjs does. The harness, and when these skip, is in claude-e2e.mjs.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { landed, pushCard, pushTurn, sdkWhy, TURN_MS, why } from './claude-e2e.mjs';

const ADAPTERS = /** @type {const} */ ([
  ['claude-code', why],
  ['agent-sdk', sdkWhy],
]);

for (const [hooksIn, owner] of /** @type {const} */ ([
  ['skill', 'a skill’s'],
  ['agent', 'a subagent’s'],
])) {
  for (const [backend, skip] of ADAPTERS) {
    test(`#871 ${backend} in Ask me: ${owner} frontmatter hook that approves doesn’t run, and the push waits on a card`, {
      skip,
      timeout: TURN_MS + 60_000,
    }, async (t) => {
      const r = await pushTurn(t, backend, 'ask', hooksIn);
      assert.ok(pushCard(r.answered), `a permission card for the push should show; the agent said: ${r.said.slice(0, 500)}`);
      assert.equal(landed(r.bare), false, 'refs/heads/e2e should not be on the remote');
      assert.equal(existsSync(r.markers.frontmatter), false, `${owner} frontmatter hook should not run`);
    });

    // The control, so “the hook doesn’t run” can’t pass because the skill or subagent never loaded, or never ran.
    test(`#871 control: ${backend} in Run everything, ${owner} frontmatter hook runs`, { skip, timeout: TURN_MS + 60_000 }, async (t) => {
      const r = await pushTurn(t, backend, 'bypass', hooksIn);
      assert.equal(existsSync(r.markers.frontmatter), true, `${owner} frontmatter hook should run; the agent said: ${r.said.slice(0, 500)}`);
    });
  }
}
