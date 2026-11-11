// What the #780 specs share: a Runtime whose agent works in a folder, a tool call over MCP from inside its turn, and
// a valid PNG of any size, built in code (tests/png.mjs).

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Blobs } from '../server/blobs.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

export { png } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roots = [];
after(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

/** An adapter that works in a folder, and runs each turn’s step with its context. */
class InFolder {
  name = 'mock';
  constructor(folder) {
    this.folder = folder;
    this.next = [];
  }
  async folderFor() {
    return this.folder;
  }
  async deliver(_se, _m, ctx) {
    await (this.next.shift() ?? (async () => {}))(ctx);
  }
}

/**
 * Runs step(ctx) inside a turn of the agent’s, and gives what it returns once the turn has ended. It waits on the step’s
 * own promise, not a bounded poll: a slow write on a loaded runner outlasted the poll and left nothing to read (#779).
 * @param {Runtime} rt @param {{ next: Function[] }} adapter @param {string} threadId @param {(ctx: any) => Promise<any>} step
 */
export async function duringTurn(rt, adapter, threadId, step) {
  const done = new Promise((ok, fail) => {
    adapter.next.push(async (c) => step(c).then(ok, fail));
  });
  rt.sendMessage(threadId, { text: 'go' });
  const out = await done;
  while (rt.turns.size) await sleep(5);
  return out;
}

/** Calls a tool over MCP from inside a turn, with that turn’s token, and gives its text and whether it failed. */
export async function callTool(rt, adapter, threadId, sessionId, name, args) {
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
  const out = await duringTurn(rt, adapter, threadId, (c) => handleMcp(rt, sessionId, msg, new URL(c.mcpUrl).searchParams.get('turn')));
  return { text: out.result?.content?.[0]?.text ?? out.error?.message, isError: out.result?.isError ?? true };
}

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pb-review-files-'));
  roots.push(root);
  const folder = join(root, 'work');
  await mkdir(join(folder, 'figs'), { recursive: true });
  const store = new Store(null);
  const adapter = new InFolder(folder);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    blobs: new Blobs(join(root, 'blobs')),
  });
  store.emit('project', { id: 'p1', name: 'P', folder: null });
  const a = rt.createPersona({ handle: 'alpha' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const se = rt.sessionsIn(t.id)[0];
  const during = (step) => duringTurn(rt, adapter, t.id, step);
  const call = (name, args) => callTool(rt, adapter, t.id, se.id, name, args);
  /** The review block item with this block id. */
  const review = (id) => store.items(t.id).find((i) => i.kind === 'block' && i.block?.id === id);
  return { rt, store, t, se, folder, root, call, during, review };
}

/** A review block with Markdown content naming figs/today.png. */
export const reviewBlock = (id, files, content = '![Today](figs/today.png)') => ({
  block: { id, type: 'review', version: 1, format: 'markdown', content, fallback: 'A review.', ...(files ? { files } : {}) },
});
