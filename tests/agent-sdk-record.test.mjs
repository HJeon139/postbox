// An Agent SDK turn’s raw stream is recorded where POSTBOX_SDK_RECORD says, as Claude Code’s, Codex’s, Kiro’s and
// Antigravity’s are (recorderFor, server/adapters/setup.mjs), so a UAT run can show a turn ran on the SDK and with
// which model (#1315).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentSdkAdapter } from '../server/adapters/agent-sdk.mjs';
import { fixtureLines } from './fake-daemon.mjs';
import { tempDir } from './temp-dirs.mjs';

// A recorded turn (tests/fixtures/claude-code/block.jsonl, claude 2.1.296): the SDK yields the same messages.
const LINES = fixtureLines('block');

const ctxFor = (folder) => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { id: 'pe_alpha', handle: 'alpha', model: 'claude-sonnet-5-5', permissionMode: 'auto', folder, description: '', instructions: '' },
  project: { id: 'pr_one', folder },
  handles: ['alpha'],
  state: {},
  saveState: () => {},
  pathOf: () => null,
  text: () => {},
  activity: () => {},
  status: () => {},
});

test('#1315: with POSTBOX_SDK_RECORD set, an Agent SDK turn writes each message it got to a file named for the agent, in a folder it makes', async (t) => {
  const record = join(tempDir('pb-sdk-record-'), 'streams', 'sdk');
  const project = tempDir('pb-sdk-project-');
  const was = process.env.POSTBOX_SDK_RECORD;
  process.env.POSTBOX_SDK_RECORD = record;
  t.after(() => {
    if (was === undefined) delete process.env.POSTBOX_SDK_RECORD;
    else process.env.POSTBOX_SDK_RECORD = was;
  });
  const sdk = {
    query: () =>
      (async function* () {
        for (const l of LINES) yield JSON.parse(l);
      })(),
  };
  const adapter = new AgentSdkAdapter({ sdk, workRoot: join(tempDir('pb-sdk-data-'), 'workspaces') });
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctxFor(project));
  const files = readdirSync(record);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d+-alpha\.jsonl$/);
  const written = readFileSync(join(record, files[0]), 'utf8').trim().split('\n');
  assert.deepEqual(
    written.map((l) => JSON.parse(l)),
    LINES.map((l) => JSON.parse(l)),
  );
});
