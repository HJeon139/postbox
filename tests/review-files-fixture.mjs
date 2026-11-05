// What the #780 specs share: a Runtime whose agent works in a folder, a tool call over MCP from inside its turn, and
// a minimal valid PNG of any size, built in code (no fixture files).

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { deflateSync } from 'node:zlib';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Blobs } from '../server/blobs.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

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

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A valid PNG of width × height (1 × 1 pixels drawn), padded with a tEXt chunk to at least `pad` bytes. */
export function png(width = 4, height = 3, pad = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const idat = deflateSync(Buffer.alloc(1 + 1)); // one row of one pixel: a valid stream, not a full image, is enough
  const extra = pad > 0 ? [chunk('tEXt', Buffer.alloc(pad, 0x41))] : [];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
