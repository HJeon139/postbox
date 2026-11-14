// What the person types in an attached Claude Code terminal goes to that terminal’s agent, and its item says so, so
// another agent reading it later in its catch-up sees it wasn’t addressed to it (#1328).

import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const line = (e) => `${JSON.stringify(e)}\n`;
const typed = (text) => ({ type: 'user', turnOrigin: 'human', cwd: '/work/site', message: { role: 'user', content: text } });
const said = (text) => ({ type: 'assistant', cwd: '/work/site', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });

/** A Claude Code session in /work/site with one exchange typed in its terminal, attached as @site. */
async function attached() {
  const root = tempDir('pb-cc-mirror-');
  await mkdir(join(root, '-work-site'));
  const id = '11111111-2222-3333-4444-555555555555';
  const file = join(root, '-work-site', `${id}.jsonl`);
  await writeFile(file, line(typed('Fix the header on mobile')) + line(said('Fixed: the header wraps now.')));
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'claude-code', deliver: async () => {} }),
    config: { origin: 'http://x', imageOrigins: [], claudeProjectsRoot: root },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/work' });
  const { threadId, sessionId } = await rt.attachClaudeSession({ claudeSessionId: id, projectId: 'p1' });
  rt.stopMirrors();
  return { rt, store, file, threadId, sessionId };
}

const typedItems = (store, threadId) => store.items(threadId).filter((i) => i.kind === 'user');

test('the history an attached terminal brings has its agent as the recipient of what the person typed', async () => {
  const { store, threadId } = await attached();
  assert.deepEqual(
    typedItems(store, threadId).map((i) => [i.text, i.to]),
    [['Fix the header on mobile', ['site']]],
  );
});

test('a turn typed in the attached terminal later is mirrored with its agent as the recipient', async () => {
  const { rt, store, file, threadId, sessionId } = await attached();
  rt.mirror(sessionId);
  clearInterval(rt.mirrors.get(sessionId).timer);
  await appendFile(file, line(typed('Now the footer')) + line(said('Footer done.')));
  rt.pollMirror(sessionId);
  assert.deepEqual(typedItems(store, threadId).at(-1).to, ['site']);
});
