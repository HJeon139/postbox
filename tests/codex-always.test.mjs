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
import { allowAlways } from '../server/permission-cards.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const command = (extra = {}) => ({ method: 'item/commandExecution/requestApproval', id: 7, params: { itemId: 'i1', command: 'gh issue list', ...extra } });
const AUTO_WEB = { permissionMode: 'auto', tools: ['shell', 'web.fetch'] };
const AUTO_OFFLINE = { permissionMode: 'auto', tools: ['shell'] };
const EDITS = { permissionMode: 'acceptEdits', tools: ['shell'] };

test('#324 a command card offers exactly Codex’s proposed prefix, answered as Codex’s own amendment', () => {
  const offer = codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['gh', 'issue'] }).params, EDITS);
  assert.deepEqual(offer?.lines, [{ text: 'Always allow commands starting with gh issue, as a Codex rule', rule: 'gh issue' }]);
  assert.deepEqual(offer?.updates, [{ type: 'codex', decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['gh', 'issue'] } } }]);
});

test('#324 no offer for a prefix that runs any program, an operator, a one-word tool with subcommands, or none', () => {
  for (const prefix of [[], ['bash', '-c', 'x'], ['npx', 'tsx'], ['npm', 'run'], ['env', 'X=1'], ['git'], ['gh'], ['cargo'], ['echo', 'a;b'], ['ls', '$(id)']])
    assert.equal(codexAlwaysOffer(command({ proposedExecpolicyAmendment: prefix }).params, EDITS), null, JSON.stringify(prefix));
  assert.equal(codexAlwaysOffer(command().params, EDITS), null, 'nothing proposed');
  // A tool that runs a program its options name: find -exec, awk's system(), GNU sed's e, tar --to-command, rsync -e.
  for (const prefix of [['find', '.'], ['awk'], ['sed', '-n'], ['tar', 'xf'], ['rsync', '-a']])
    assert.equal(codexAlwaysOffer(command({ proposedExecpolicyAmendment: prefix }).params, EDITS), null, JSON.stringify(prefix));
  // For a tool with subcommands, the second word must be a subcommand: `git -c` would allow `git -c core.fsmonitor=…`.
  for (const prefix of [
    ['git', '-c'],
    ['git', '-C'],
    ['git', '--exec-path'],
    ['gh', '--repo'],
  ])
    assert.equal(codexAlwaysOffer(command({ proposedExecpolicyAmendment: prefix }).params, EDITS), null, JSON.stringify(prefix));
  // Two words of a tool with subcommands are fine.
  assert.notEqual(codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['git', 'status'] }).params, EDITS), null);
});

test('#324 a network stop offers its host in Accept edits, and nothing in Auto for a persona that may not fetch the web', () => {
  const params = command({
    networkApprovalContext: { host: 'api.github.com' },
    proposedNetworkPolicyAmendments: [{ host: 'api.github.com', action: 'allow' }],
  }).params;
  const offer = codexAlwaysOffer(params, EDITS);
  assert.deepEqual(offer?.lines, [{ text: 'Always allow network access to api.github.com, as a Codex rule', rule: 'api.github.com' }]);
  assert.deepEqual(offer?.updates, [
    { type: 'codex', decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'api.github.com', action: 'allow' } } } },
  ]);
  assert.equal(codexAlwaysOffer(params, AUTO_OFFLINE), null, 'one click would undo “personas without web access stay offline”');
  assert.notEqual(codexAlwaysOffer(params, AUTO_WEB), null);
  // A deny amendment is never offered as an allow.
  assert.equal(
    codexAlwaysOffer(
      command({ networkApprovalContext: { host: 'x.example' }, proposedNetworkPolicyAmendments: [{ host: 'x.example', action: 'deny' }] }).params,
      EDITS,
    ),
    null,
  );
});

test('#324 codexApproval sends the offer on the card, and answers Always allow as Codex’s decision, once as accept', async () => {
  /** @type {any[]} */
  const asked = [];
  const ctx = (answer) => ({
    persona: EDITS,
    askPermission: async (req) => {
      asked.push(req);
      return answer(req);
    },
  });
  const msg = command({ proposedExecpolicyAmendment: ['gh', 'issue'] });
  const always = await codexApproval(
    ctx((req) => ({ allow: true, updatedPermissions: req.suggestions.updates })),
    msg,
  );
  assert.deepEqual(always, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['gh', 'issue'] } } });
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
  const p = rt.createPersona({ handle: 'coder', backend: 'codex', permissionMode: 'acceptEdits', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  let decision;
  adapter.next.push(async (c) => {
    decision = await codexApproval(c, command({ proposedExecpolicyAmendment: ['gh', 'issue'] }));
  });
  rt.sendMessage(t.id, { text: 'list issues' });
  const card = await waitFor(() => store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open'));
  assert.deepEqual(
    card.always.lines.map((l) => l.text),
    ['Always allow commands starting with gh issue, as a Codex rule'],
  );
  await rt.act(t.id, card.id, 'always', {});
  await waitFor(() => decision);
  assert.deepEqual(decision, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['gh', 'issue'] } } });
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

test('#324 on a host turn’s card, a harness’s own offer is allowed always; Postbox’s own rule there still isn’t', async () => {
  const settled = [];
  const rt = { addItem: () => {}, settlePermission: (...a) => settled.push(a) };
  const offer = codexAlwaysOffer(command({ proposedExecpolicyAmendment: ['gh', 'issue'] }).params, EDITS);
  const remote = { hostId: 'ho_1', turn: 't', id: 'p1' };
  assert.deepEqual(await allowAlways(rt, 'th_1', { id: 'it_1', always: offer, remote }, '@coder to run a command'), { ok: true });
  assert.deepEqual(settled[0][3], { updatedPermissions: offer?.updates });
  await assert.rejects(allowAlways(rt, 'th_1', { id: 'it_2', always: { lines: [{ text: 'x' }], updates: [{ type: 'addRules' }] }, remote }, 'x'), {
    status: 409,
  });
});
