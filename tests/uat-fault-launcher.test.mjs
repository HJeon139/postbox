// The fault launcher (#508, tools/uat/fault-launcher.mjs): which run of a CLI it fails, and where in the stream. The
// session events are the first ones of each backend’s recorded turns in tests/fixtures/.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleOf, isProbe, isSessionEvent, parseFault, shouldFail } from '../tools/uat/fault-launcher.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';

const FIX = join(import.meta.dirname, 'fixtures');
const lines = (path) => readFileSync(join(FIX, path), 'utf8').split('\n').filter(Boolean);
const guide = (h) => ['-p', '--append-system-prompt', `You are @${h}, an agent in Postbox: a chat room where one person directs several AI agents.`];

test('a fault line names the agent and which of its turns fails', () => {
  assert.deepEqual(parseFault('fail-before-output researcher 1'), {
    kind: 'fail-before-output',
    agent: 'researcher',
    n: 1,
    line: 'fail-before-output researcher 1',
  });
  assert.equal(parseFault('fail-before-output researcher 0'), null);
  assert.equal(parseFault('fail-after-output researcher 1'), null);
});

test('each backend’s first session event is recognized, and nothing before it', () => {
  const claude = lines('claude-code/background-failed.jsonl');
  const first = claude.findIndex(isSessionEvent);
  assert.equal(JSON.parse(claude[first]).subtype, 'init');
  assert.equal(claude.slice(0, first).some(isSessionEvent), false);
  assert.equal(isSessionEvent(lines('antigravity-cli/first.jsonl')[0]), true);
  assert.equal(isSessionEvent(lines('codex-app-server/turn.jsonl').find((l) => l.includes('"turn/started"')) ?? ''), true);
  // The Kiro CLI’s recorded lines wrap each ACP session update; on its stdout it comes as session/update.
  const kiro = JSON.parse(lines('kiro-cli/first.jsonl').find((l) => l.includes('sessionId')) ?? '{}');
  assert.equal(isSessionEvent(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: kiro.data })), true);
  assert.equal(isSessionEvent('not json'), false);
});

test('the agent comes from the guide in a turn’s arguments, and probes aren’t turns', () => {
  assert.equal(handleOf(guide('critic')), 'critic');
  assert.equal(handleOf(['app-server', '--listen', 'stdio://']), null);
  assert.equal(isProbe(['--version']), true);
  assert.equal(isProbe(['chat', '--list-models', '--format', 'json']), true);
  assert.equal(isProbe(['app-server', '--listen', 'stdio://']), true);
  assert.equal(isProbe(['app-server', '--listen', 'stdio://', '-c', 'mcp_servers.postbox.url="x"']), false);
});

test('only the faulted agent’s nth turn since the fault was armed fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-fault-'));
  try {
    const env = { POSTBOX_UAT_FAULT: 'fail-before-output researcher 2', POSTBOX_UAT_FAULT_STATE: join(dir, 'state') };
    assert.equal(shouldFail(guide('critic'), env), false, 'another agent’s turn');
    assert.equal(shouldFail(['--version'], env), false, 'a probe');
    assert.equal(shouldFail(guide('researcher'), env), false, 'its first turn');
    assert.equal(shouldFail(guide('researcher'), env), true, 'its second turn');
    assert.equal(shouldFail(guide('researcher'), env), false, 'its third turn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fault armed from a file counts from its next turn, and nothing fails before it’s armed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-fault-'));
  try {
    const env = { POSTBOX_UAT_FAULT_FILE: join(dir, 'fault'), POSTBOX_UAT_FAULT_STATE: join(dir, 'state') };
    assert.equal(shouldFail(guide('researcher'), env), false, 'not armed yet');
    writeFileSync(env.POSTBOX_UAT_FAULT_FILE, 'fail-before-output researcher 1\n');
    assert.equal(shouldFail(guide('researcher'), env), true);
    assert.equal(shouldFail(guide('researcher'), env), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a CLI given no guide in its arguments counts every turn as the faulted agent’s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-fault-'));
  try {
    const env = { POSTBOX_UAT_FAULT: 'fail-before-output researcher 1', POSTBOX_UAT_FAULT_STATE: dir };
    assert.equal(shouldFail(['app-server', '--listen', 'stdio://', '-c', 'x=1'], env), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a scenario’s phase names the fault the launcher arms, as delivery.md’s phase 3 does', () => {
  const sc = parseScenario(
    '# D\n\n## Phase 3: A turn that fails\n\n- fault: fail-before-output researcher 1\n- triggers: fail-before-output\n- steps: 6\n\nAsk @researcher.\n',
  );
  assert.equal(sc.phases[0].fault, 'fail-before-output researcher 1');
  assert.deepEqual(parseFault(sc.phases[0].fault), { kind: 'fail-before-output', agent: 'researcher', n: 1, line: 'fail-before-output researcher 1' });
  assert.equal(sc.phases[0].text, 'Ask @researcher.');
});
