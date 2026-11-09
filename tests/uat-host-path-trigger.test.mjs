// #672’s UAT trigger, host-node-found, on recorded-shape streams: it fires for an agent on a host whose plain
// `node --version` printed a version, and not for one that failed with exit 127, set its own PATH, ran locally, or
// named node by its full path.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PATH_TRIGGERS } from '../tools/uat/triggers-path.mjs';

const run = PATH_TRIGGERS['host-node-found'].run;
/** A run with one agent placed where `place` says, whose stream ran `command` and got `text`. */
function facts({ place = 'host1', command = 'node --version', text = 'v22.11.0', error = false } = {}) {
  return {
    hosts: { hosts: [{ id: 'ho_1', label: 'host1' }], placement: { researcher: place } },
    streams: [
      {
        handle: 'researcher',
        events: [
          { type: 'assistant', timestamp: '2026-11-09T00:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } },
          { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: error, content: text }] } },
        ],
      },
    ],
  };
}

test('#672 host-node-found fires for a plain node --version on a host that printed a version', () => {
  const hits = run(facts());
  assert.equal(hits.length, 1);
  assert.match(hits[0].evidence, /host1: @researcher’s `node --version` printed v22\.11\.0/);
});

test('#672 host-node-found stays quiet for exit 127, an agent’s own PATH, a full path, or a local agent', () => {
  assert.deepEqual(run(facts({ text: 'Exit code 127\nzsh: command not found: node', error: true })), []);
  assert.deepEqual(run(facts({ command: 'PATH=$HOME/.local/share/mise/installs/node/22/bin:$PATH node --version' })), []);
  assert.deepEqual(run(facts({ command: '~/.local/share/mise/installs/node/22/bin/node --version' })), []);
  assert.deepEqual(run(facts({ place: 'local' })), []);
});

test('#672 remotehosts’ phase 8 asks for exactly node --version on host1, and names its trigger', async () => {
  const { readFileSync } = await import('node:fs');
  const { parseScenario } = await import('../tools/uat/scenario.mjs');
  const scenario = parseScenario(readFileSync(new URL('uat/e2e/scenarios/remotehosts.md', import.meta.url), 'utf8'));
  const phase = scenario.phases.at(-1);
  assert.deepEqual(phase.triggers, ['host-node-found']);
  assert.match(phase.text, /run exactly `node --version`/);
});
