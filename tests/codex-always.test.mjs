// #324: Always allow on a Codex command card saves Codex’s own rule. The card offers exactly the amendment Codex
// proposed (an exec-policy prefix, or a network host), never a wider one, and none for a prefix that would run any
// program (#281’s rule); the answer goes back to Codex as its own decision, and Postbox writes no rule file.

import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { codexAlwaysOffer } from '../server/adapters/codex-always.mjs';
import { codexApproval } from '../server/adapters/codex-approval.mjs';
import { alwaysFor } from '../server/permission-always.mjs';
import { allowAlways } from '../server/permission-cards.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const command = (extra = {}) => ({ method: 'item/commandExecution/requestApproval', id: 7, params: { itemId: 'i1', command: 'gh issue list', ...extra } });
const AUTO_WEB = { permissionMode: 'auto', tools: ['shell', 'web.fetch'] };
const AUTO_OFFLINE = { permissionMode: 'auto', tools: ['shell'] };
const EDITS = { permissionMode: 'acceptEdits', tools: ['shell'] };
const EDITS_WEB = { permissionMode: 'acceptEdits', tools: ['shell', 'web.fetch'] };

test('#324 a command card offers exactly Codex’s proposed prefix, answered as Codex’s own amendment', () => {
  const offer = codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['gh', 'issue', 'view'] }).params, EDITS_WEB);
  assert.deepEqual(offer?.lines, [
    {
      text: 'Always allow gh issue view and any command starting with it, as a Codex rule: they run outside its sandbox, with no card, in every Codex session on this computer',
      rule: 'gh issue view',
    },
  ]);
  assert.deepEqual(offer?.updates, [{ type: 'codex', decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['gh', 'issue', 'view'] } } }]);
});

test('#324 no offer for a prefix that runs any program, an operator, a one-word tool with subcommands, or none', () => {
  for (const prefix of [[], ['bash', '-c', 'x'], ['npx', 'tsx'], ['npm', 'run'], ['env', 'X=1'], ['git'], ['gh'], ['cargo'], ['echo', 'a;b'], ['ls', '$(id)']])
    assert.equal(codexAlwaysOffer(command({ proposedExecpolicyAmendment: prefix }).params, EDITS_WEB), null, JSON.stringify(prefix));
  assert.equal(codexAlwaysOffer(command().params, EDITS_WEB), null, 'nothing proposed');
  // A tool that runs a program its options name: find -exec, awk's system(), GNU sed's e, tar --to-command, rsync -e.
  for (const prefix of [['find', '.'], ['awk'], ['sed', '-n'], ['tar', 'xf'], ['rsync', '-a']])
    assert.equal(codexAlwaysOffer(command({ proposedExecpolicyAmendment: prefix }).params, EDITS_WEB), null, JSON.stringify(prefix));
  // For a tool with subcommands, the second word must be a subcommand: `git -c` would allow `git -c core.fsmonitor=…`.
  for (const prefix of [
    ['git', '-c'],
    ['git', '-C'],
    ['git', '--exec-path'],
    ['gh', '--repo'],
  ])
    assert.equal(codexAlwaysOffer(command({ proposedExecpolicyAmendment: prefix }).params, EDITS_WEB), null, JSON.stringify(prefix));
  // A read-only gh command is offered.
  assert.notEqual(codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['gh', 'pr', 'view'] }).params, EDITS_WEB), null);
});

test('#324 a network stop offers its host to a persona that may fetch the web, and nothing to one that may not', () => {
  const params = command({
    networkApprovalContext: { host: 'api.github.com' },
    proposedNetworkPolicyAmendments: [{ host: 'api.github.com', action: 'allow' }],
  }).params;
  const offer = codexAlwaysOffer(params, AUTO_WEB);
  assert.deepEqual(offer?.lines, [
    { text: 'Always allow api.github.com for network access, as a Codex rule, in every Codex session on this computer', rule: 'api.github.com' },
  ]);
  assert.deepEqual(offer?.updates, [
    { type: 'codex', decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'api.github.com', action: 'allow' } } } },
  ]);
  assert.equal(codexAlwaysOffer(params, AUTO_OFFLINE), null, 'one click would undo “personas without web access stay offline”');
  assert.notEqual(codexAlwaysOffer(params, AUTO_WEB), null);
  // A deny amendment is never offered as an allow.
  assert.equal(
    codexAlwaysOffer(
      command({ networkApprovalContext: { host: 'x.example' }, proposedNetworkPolicyAmendments: [{ host: 'x.example', action: 'deny' }] }).params,
      EDITS_WEB,
    ),
    null,
  );
});

test('#324 codexApproval sends the offer on the card, and answers Always allow as Codex’s decision, once as accept', async () => {
  /** @type {any[]} */
  const asked = [];
  const ctx = (answer) => ({
    persona: EDITS_WEB,
    askPermission: async (req) => {
      asked.push(req);
      return answer(req);
    },
  });
  const msg = command({ proposedExecpolicyAmendment: ['gh', 'issue', 'view'] });
  const always = await codexApproval(
    ctx((req) => ({ allow: true, updatedPermissions: req.suggestions.updates })),
    msg,
  );
  assert.deepEqual(always, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['gh', 'issue', 'view'] } } });
  assert.equal(asked[0].suppressAlways, false);
  assert.deepEqual(
    await codexApproval(
      ctx(() => ({ allow: true })),
      msg,
    ),
    { decision: 'accept' },
  );
  assert.deepEqual(
    await codexApproval(
      ctx(() => ({ allow: false })),
      msg,
    ),
    { decision: 'decline' },
  );
  // A file change proposes nothing Codex can save, so its card offers nothing.
  await codexApproval(
    ctx(() => ({ allow: true })),
    { method: 'item/fileChange/requestApproval', id: 8, params: { itemId: 'i2' } },
  );
  assert.equal(asked.at(-1).suppressAlways, true);
  assert.equal(asked.at(-1).suggestions ?? null, null);
});

/** A Codex agent whose turn the test scripts, in a temp folder. */
class ScriptedCodex {
  name = 'codex';
  constructor(folder) {
    this.folder = folder;
    this.next = [];
  }
  async folderFor() {
    return this.folder;
  }
  async deliver(_session, _message, ctx) {
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx);
  }
}

test('#324 Always allow on the card hands Codex’s decision back and writes no rule file', async () => {
  const root = tempDir('pb-codex-always-');
  const folder = join(root, 'work');
  await mkdir(folder);
  const store = new Store(null);
  const adapter = new ScriptedCodex(folder);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: root },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'coder', backend: 'codex', permissionMode: 'acceptEdits', tools: ['shell', 'web.fetch'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  let decision;
  adapter.next.push(async (c) => {
    decision = await codexApproval(c, command({ proposedExecpolicyAmendment: ['gh', 'issue', 'view'] }));
  });
  rt.sendMessage(t.id, { text: 'list issues' });
  const card = await waitFor(() => store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open'));
  assert.deepEqual(
    card.always.lines.map((l) => l.text),
    [
      'Always allow gh issue view and any command starting with it, as a Codex rule: they run outside its sandbox, with no card, in every Codex session on this computer',
    ],
  );
  await rt.act(t.id, card.id, 'always', {});
  await waitFor(() => decision);
  assert.deepEqual(decision, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['gh', 'issue', 'view'] } } });
  assert.equal(store.item(t.id, card.id).status, 'allowed-always');
  assert.deepEqual(await readdir(folder), [], 'Codex saves its rule; Postbox writes nothing in the folder');
});

/** check()’s first truthy value, looked at every 5 ms, within 2 s. @template T @param {() => T} check */
async function waitFor(check) {
  for (let i = 0; i < 400; i++) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Timed out.');
}

test('#324 a host turn’s card offers no Codex rule, and Always allow there is refused: the rule would go on the host', async () => {
  const offer = codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['gh', 'issue', 'view'] }).params, EDITS_WEB);
  assert.equal(alwaysFor({}, {}, { tool: 'Bash', input: {}, suggestions: offer, suppressAlways: false, hostId: 'ho_1' }), null);
  assert.deepEqual(alwaysFor({}, {}, { tool: 'Bash', input: {}, suggestions: offer, suppressAlways: false }), offer, 'on this computer it is offered');
  const rt = { addItem: () => {}, settlePermission: () => {} };
  const remote = { hostId: 'ho_1', turn: 't', id: 'p1' };
  await assert.rejects(allowAlways(rt, 'th_1', { id: 'it_1', always: offer, remote }, '@coder to run a command'), { status: 409 });
});

// A matching rule runs the command outside Codex’s sandbox and asks no one, for every Codex session on the computer:
// codex-rs/core/src/exec_policy.rs at rust-v0.167.0, :467–469 (Skip { bypass_sandbox }) and :904–905 (rules/default.rules).
test('#324 no offer for a path or assignment as the first word, a versioned interpreter, a launcher, or a run subcommand', () => {
  const offline = (prefix) => codexAlwaysOffer(command({ proposedExecpolicyAmendment: prefix }).params, EDITS_WEB);
  for (const prefix of [
    ['/bin/sh'],
    ['/usr/bin/env', 'x'],
    ['./run.sh'],
    ['FOO=bar', 'node'],
    ['python3.12', 'x.py'],
    ['bunx', 'x'],
    ['uvx', 'x'],
    ['tsx', 'x'],
    ['osascript', '-e'],
    ['uv', 'run'],
    ['cargo', 'run'],
    ['go', 'run'],
    ['kubectl', 'exec'],
    ['gh', 'extension'],
    ['npm', 'x'],
    ['python3'],
    ['/usr/bin/bash'],
    ['FOO=1', 'make'],
    ['pnpm', 'dlx'],
    ['pipx', 'run'],
    ['poetry', 'run'],
    ['ls', 'x'.repeat(118)],
    ['pip3'],
    ['go1.22'],
    ['.'],
    ['source'],
  ])
    assert.equal(offline(prefix), null, JSON.stringify(prefix));
  assert.notEqual(offline(['ls', '-la']), null, 'a program on the read-only list is offered');
});

test('#324 a persona without Web is offered no prefix in any mode, and a host only in Auto with Web', () => {
  const prefix = command({ proposedExecpolicyAmendment: ['ls', 'src'] }).params;
  assert.equal(codexAlwaysOffer(prefix, AUTO_OFFLINE), null, 'a rule would run it outside the offline sandbox');
  assert.notEqual(codexAlwaysOffer(prefix, AUTO_WEB), null);
  const host = command({
    networkApprovalContext: { host: 'api.github.com' },
    proposedNetworkPolicyAmendments: [{ host: 'api.github.com', action: 'allow' }],
  }).params;
  for (const persona of [EDITS, { permissionMode: 'ask', tools: ['shell'] }]) assert.equal(codexAlwaysOffer(host, persona), null, persona.permissionMode);
  // Outside Auto the sandbox is offline for every persona, so a host rule would give network that mode never has.
  assert.equal(codexAlwaysOffer(host, EDITS_WEB), null, 'a host in Accept edits');
  // A matching command runs outside the sandbox, with network, in every mode: none for a persona without Web.
  assert.equal(codexAlwaysOffer(prefix, EDITS), null, 'a prefix in Accept edits without Web');
});

test('#324 the card says the rule runs outside Codex’s sandbox, for every Codex session; a wildcard host or a long prefix is refused', () => {
  const offer = codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['gh', 'issue', 'view'] }).params, EDITS_WEB);
  assert.equal(
    offer?.lines[0].text,
    'Always allow gh issue view and any command starting with it, as a Codex rule: they run outside its sandbox, with no card, in every Codex session on this computer',
  );
  const web = AUTO_WEB;
  for (const h of ['*', '*.example.com', 'a b', '.', '-', '...', 'localhost', '1.2.3.4'])
    assert.equal(
      codexAlwaysOffer(command({ networkApprovalContext: { host: h }, proposedNetworkPolicyAmendments: [{ host: h, action: 'allow' }] }).params, web),
      null,
      h,
    );
  assert.equal(codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['ls', 'x'.repeat(130)] }).params, EDITS_WEB), null, 'too long to show whole');
});

test('#324 a file-change request is offered nothing, even with a proposal on it', async () => {
  const asked = [];
  const ctx = { persona: EDITS_WEB, askPermission: async (req) => (asked.push(req) ? { allow: true } : null) };
  const res = await codexApproval(ctx, {
    method: 'item/fileChange/requestApproval',
    id: 9,
    params: { itemId: 'i3', proposedExecpolicyAmendment: ['gh', 'issue', 'view'] },
  });
  assert.deepEqual(res, { decision: 'accept' });
  assert.equal(asked[0].suppressAlways, true);
});

// The card shows each line as “Always allow <code>rule</code>” and then the text past
// `Always allow ${rule}` (app/js/permission-cards.mjs, the card’s Always allow), so a text that doesn’t start that way
// is garbled on the card: “Always allow `ls`mmands starting with ls…”. Every offer must start with its rule.
test('#324 every line Codex’s Always allow offers starts with “Always allow <its rule>”, as the card shows it', () => {
  const offers = [
    codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['ls'] }).params, EDITS_WEB),
    codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['gh', 'pr', 'view'] }).params, EDITS_WEB),
    codexAlwaysOffer(
      command({ networkApprovalContext: { host: 'api.github.com' }, proposedNetworkPolicyAmendments: [{ host: 'api.github.com', action: 'allow' }] }).params,
      AUTO_WEB,
    ),
  ];
  for (const offer of offers) for (const l of offer?.lines ?? assert.fail('an offer')) assert.ok(l.text.startsWith(`Always allow ${l.rule} `), l.text);
});
