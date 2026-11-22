// A Claude Code terminal’s tool calls, mirrored into Postbox (server/claude-mirror.mjs) or brought as its history
// (server/adapters/terminal-mirror.mjs), name the tool each step ran, as a Postbox turn’s steps do (#1527).

import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { entriesToItems } from '../server/adapters/terminal-mirror.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const line = (e) => `${JSON.stringify(e)}\n`;
const typed = (text) => ({ type: 'user', turnOrigin: 'human', cwd: '/work/site', message: { role: 'user', content: text } });
// As Claude Code writes a tool call in its transcript.
const read = {
  type: 'assistant',
  cwd: '/work/site',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/work/site/a.css' } }] },
};

test('a terminal’s history names the tool each of its steps ran', () => {
  const [, agent] = entriesToItems([typed('Fix the header'), read]);
  assert.deepEqual(
    agent.steps.map((s) => [s.id, s.tool]),
    [['toolu_r', 'Read']],
  );
});

test('a tool call mirrored from an attached terminal names the tool its step ran', async () => {
  const root = tempDir('pb-cc-tools-');
  await mkdir(join(root, '-work-site'));
  const id = '11111111-2222-3333-4444-555555555555';
  const file = join(root, '-work-site', `${id}.jsonl`);
  await writeFile(file, line(typed('Fix the header on mobile')));
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'claude-code', deliver: async () => {} }),
    config: { origin: 'http://x', imageOrigins: [], claudeProjectsRoot: root },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/work' });
  const { threadId, sessionId } = await rt.attachClaudeSession({ claudeSessionId: id, projectId: 'p1' });
  rt.stopMirrors();
  rt.mirror(sessionId);
  clearInterval(rt.mirrors.get(sessionId).timer);
  await appendFile(file, line(typed('Now the footer')) + line(read));
  rt.pollMirror(sessionId);
  const agent = store.items(threadId).findLast((i) => i.kind === 'agent');
  assert.deepEqual(
    agent.activity.steps.map((s) => [s.id, s.tool]),
    [['toolu_r', 'Read']],
  );
});
