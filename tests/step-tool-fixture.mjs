// The ways a tool call’s step is made, each run once, for the step-tool tests on and off UAT recording mode
// (tests/step-tool-on.test.mjs, tests/step-tool-off.test.mjs). Steps read the mode when server/step-text.mjs loads, so
// a test file sets it, then imports this file: every server module here is imported after that.

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './temp-dirs.mjs';

const { AdapterRegistry } = await import('../server/adapters/adapter.mjs');
const { entriesToItems } = await import('../server/adapters/terminal-mirror.mjs');
const { HarnessEvents } = await import('../server/harness-events.mjs');
const { Runtime } = await import('../server/runtime.mjs');
const { Store } = await import('../server/store.mjs');
const { turnStep } = await import('../server/step-text.mjs');

const line = (e) => `${JSON.stringify(e)}\n`;
const typed = (text) => ({ type: 'user', turnOrigin: 'human', cwd: '/work/site', message: { role: 'user', content: text } });
// As Claude Code writes a tool call in its transcript.
const read = {
  type: 'assistant',
  cwd: '/work/site',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/work/site/a.css' } }] },
};

/** A step as a turn keeps it (server/step-text.mjs, turnStep), from a tool call’s activity. */
export const keptStep = () => turnStep({ id: 'toolu_1', label: 'Print CLAUDE_EFFORT environment variable', tool: 'Bash', state: 'running' });

/** A turn’s steps from the harness (server/harness-events.mjs): a Bash call, and a Postbox tool its harness refused. */
export function harnessSteps({ refusedAfter = false } = {}) {
  /** @type {any[]} */
  const activity = [];
  const ctx = { activity: (/** @type {any} */ a) => activity.push(a), status: () => {}, text: () => {} };
  const { event } = new HarnessEvents(ctx, { now: () => 0 });
  event({ kind: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' }, final: true });
  // Postbox’s own tools are quiet (QUIET, server/tool-labels.mjs): a refusal is the only step they show.
  event({ kind: 'tool_call', id: 'q1', name: 'mcp__postbox__show_block', input: { block: {} }, final: true });
  // A refusal at its result, or one its harness reports after the call had ended (refusedAfter).
  if (refusedAfter) event({ kind: 'tool_result', id: 'q1', text: 'ok' });
  event({ kind: 'tool_result', id: 'q1', refused: 'Its allow rule is missing.' });
  return { started: activity.find((a) => a.id === 't1'), denied: activity.filter((a) => a.state === 'denied') };
}

/** A Claude Code terminal’s history, as attaching it brings it (server/adapters/terminal-mirror.mjs). */
export const historySteps = () => entriesToItems([typed('Fix the header'), read])[1].steps;

/** A tool call typed in an attached terminal later, as the mirror brings it (server/claude-mirror.mjs). */
export async function mirroredSteps() {
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
  return store.items(threadId).findLast((i) => i.kind === 'agent').activity.steps;
}
