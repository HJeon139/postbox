// #324: Always allow on a Codex command card offers a rule only for a short list of programs that read and print.
// critic’s integrator pass on 125a92b0 found that a list of programs to refuse kept missing some. Each prefix refused
// below was offered on 125a92b0, and each runs a program, or can, outside the sandbox.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexAlwaysOffer } from '../server/adapters/codex-always.mjs';

const EDITS_WEB = { permissionMode: 'acceptEdits', tools: ['shell', 'web.fetch'] };
const command = (prefix) => ({ itemId: 'i1', command: prefix.join(' '), proposedExecpolicyAmendment: prefix });

test('#324 only a read-only program is offered: other shells, launchers, runtimes, run-like subcommands and case', () => {
  const offered = (prefix) => codexAlwaysOffer(command(prefix), EDITS_WEB);
  for (const prefix of [
    ['Bash'],
    ['PYTHON3'],
    ['cargo', 'RUN'],
    ['ksh'],
    ['dash'],
    ['csh'],
    ['tcsh'],
    ['caffeinate'],
    ['arch'],
    ['stdbuf'],
    ['script'],
    ['parallel'],
    ['xcrun'],
    ['nodejs'],
    ['ipython'],
    ['lua'],
    ['java'],
    ['swift'],
    ['pnpx'],
    ['git', 'submodule'],
    ['git', 'fetch'],
    ['git', 'grep'],
    ['git', 'status'],
    ['uv', 'tool'],
    ['brew', 'sh'],
    ['gh', 'alias'],
    ['gh', 'pr'],
    ['gh', 'pr', 'merge'],
    ['go', 'generate'],
    ['go', 'test'],
    ['cargo', 'install'],
    ['cargo', 'test'],
    ['rg'],
    ['sort'],
    ['curl', 'example.com'],
    ['LS'],
  ])
    assert.equal(offered(prefix), null, JSON.stringify(prefix));
  for (const prefix of [['ls'], ['cat', 'README.md'], ['grep', '-rn'], ['gh', 'issue', 'list'], ['gh', 'run', 'view', '42']])
    assert.notEqual(offered(prefix), null, JSON.stringify(prefix));
});
