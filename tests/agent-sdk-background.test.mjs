// #1714: on the Agent SDK backend, background work an agent left running after its reply was stopped once the SDK’s
// wait for it ran out (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, 10 min by default), and the agent wasn’t told. Two local
// recordings of 26 November 2026 (SDK 0.3.306, claude 2.1.306) showed it: with the limit at 30 s, the SDK stopped a
// background `sleep 90` 5 s after the reply’s result, while `claude -p` with the same setting waited the full 90 s.
// tests/fixtures/agent-sdk/background-limit.jsonl is the SDK run, its paths and ids replaced.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentSdkAdapter } from '../server/adapters/agent-sdk.mjs';
import { QUIET } from '../shared/limits.mjs';
import { fixtureLines } from './fake-daemon.mjs';
import { tempDir } from './temp-dirs.mjs';

const RECORDED = readFileSync(new URL('./fixtures/agent-sdk/background-limit.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

/** A turn of the adapter over these messages: what it was told, and the options its query got. */
async function turnOver(messages, { abort = false } = {}) {
  const folder = tempDir('pb-sdk-bg-');
  const told = [];
  let options = null;
  const controller = new AbortController();
  const sdk = {
    query: (/** @type {any} */ q) => {
      options = q.options;
      return (async function* () {
        for (const m of messages) yield m;
        if (abort) controller.abort();
      })();
    },
  };
  const ctx = {
    signal: controller.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { id: 'pe_alpha', handle: 'alpha', model: 'claude-haiku-5-5', permissionMode: 'auto', folder, description: '', instructions: '' },
    project: { id: 'pr_one', folder },
    handles: ['alpha'],
    state: {},
    saveState: () => {},
    pathOf: () => null,
    text: () => {},
    activity: () => {},
    status: () => {},
    tell: (/** @type {string} */ t) => told.push(t),
  };
  const adapter = new AgentSdkAdapter({ sdk, workRoot: join(tempDir('pb-sdk-bg-data-'), 'workspaces') });
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctx).catch(() => {});
  return { told, options };
}

test('#1714 the SDK’s wait for background work after a reply is Postbox’s bound, not its 10 minutes', async () => {
  const { options } = await turnOver(RECORDED);
  assert.equal(options.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, String(QUIET.backgroundMax));
  assert.equal(QUIET.backgroundMax, 2 * 60 * 60 * 1000);
});

test('#1714 background work the bound stopped after the reply is named to the agent, once, as not finished', async () => {
  const { told } = await turnOver(RECORDED);
  assert.equal(told.length, 1);
  assert.match(told[0], /^Background work you started was stopped after your reply, before it finished: “Sleep 90 seconds then write done marker file”\./);
  assert.match(told[0], /Postbox waits up to 2 h for background work after a reply\./);
  assert.match(told[0], /run it again, in the foreground or in smaller parts/);
});

test('#1714 background work stopped mid-turn, before a reply, isn’t told: the agent or its harness stopped it', async () => {
  // claude 2.1.296: a background command the agent stopped itself, before its turn’s result.
  const { told } = await turnOver(fixtureLines('background-stopped').map((l) => JSON.parse(l)));
  assert.deepEqual(told, []);
});

test('#1714 a turn the person stopped isn’t told it: Stop says what it stopped', async () => {
  const { told } = await turnOver(RECORDED, { abort: true });
  assert.deepEqual(told, []);
});

test('#1714 work stopped once the agent is working again after a result isn’t told: that’s mid-turn', async () => {
  const [result] = RECORDED.filter((m) => m.type === 'result');
  const assistant = RECORDED.find((m) => m.type === 'assistant');
  const stopped = RECORDED.find((m) => m.subtype === 'task_notification' && m.status === 'stopped');
  const { told } = await turnOver([result, assistant, stopped, result]);
  assert.deepEqual(told, []);
});

test('#1714 what an adapter tells (ctx.tell) is what the agent reads at the start of its next turn', async () => {
  const { setup, settle } = await import('./side-threads-fixture.mjs');
  const f = setup();
  f.adapter.next.push(async (/** @type {any} */ ctx) => {
    ctx.tell('Background work you started was stopped.');
    ctx.text('launched');
  });
  f.rt.sendMessage(f.t.id, { text: '@beta start the review' });
  await settle(f.rt);
  f.rt.sendMessage(f.t.id, { text: '@beta how did it go?' });
  await settle(f.rt);
  assert.match(JSON.stringify(f.adapter.calls.at(-1).message.context ?? []), /\[Postbox\] Background work you started was stopped\./);
});

test('#1714 a background subagent stopped while it was still sending its own messages is told too', async () => {
  // The subagent’s messages come forwarded with parent_tool_use_id (forwardSubagentText): the agent isn’t at work again.
  const [result] = RECORDED.filter((m) => m.type === 'result');
  const forwarded = RECORDED.find((m) => m.type === 'assistant' && m.parent_tool_use_id);
  assert.ok(forwarded, 'the recording has a subagent’s forwarded message');
  const stopped = RECORDED.find((m) => m.subtype === 'task_notification' && m.status === 'stopped');
  const { told } = await turnOver([result, forwarded, stopped]);
  assert.equal(told.length, 1);
});
