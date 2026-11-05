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
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    blobs: new Blobs(join(root, 'blobs')),
  });
  store.emit('project', { id: 'p1', name: 'P', folder: null });
  const a = rt.createPersona({ handle: 'alpha' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const se = rt.sessionsIn(t.id)[0];
  /** Calls a tool over MCP from inside a turn, with that turn’s token. */
  const call = async (name, args) => {
    let out = null;
    adapter.next.push(async (c) => {
      out = await handleMcp(
        rt,
        se.id,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        new URL(c.mcpUrl).searchParams.get('turn'),
      );
    });
    rt.sendMessage(t.id, { text: 'go' });
    for (let i = 0; i < 100 && (out === null || rt.turns.size); i++) await sleep(5);
    return { text: out.result?.content?.[0]?.text ?? out.error?.message, isError: out.result?.isError ?? true };
  };
  /** The review block item with this block id. */
  const review = (id) => store.items(t.id).find((i) => i.kind === 'block' && i.block?.id === id);
  return { rt, store, t, se, folder, root, call, review };
}

/** A review block with Markdown content naming figs/today.png. */
export const reviewBlock = (id, files, content = '![Today](figs/today.png)') => ({
  block: { id, type: 'review', version: 1, format: 'markdown', content, fallback: 'A review.', ...(files ? { files } : {}) },
});
