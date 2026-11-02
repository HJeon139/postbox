// What the asset tools’ tests share (#516 S3b): a runtime whose store keeps a data folder, so assets/ is there, with a
// project folder for path writes, and two agents in one conversation.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { assetTools } from '../server/asset-tools.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { ScriptedAdapter } from './side-threads-fixture.mjs';

export async function assetRoom({ store = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-asset-tools-'));
  const folder = mkdtempSync(join(tmpdir(), 'pb-asset-folder-'));
  const s = store ?? (await new Store(join(dir, 'data')).load());
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store: s,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  s.emit('project', { id: 'p1', name: 'P', folder });
  const a = rt.createPersona({ handle: 'alpha' });
  const b = rt.createPersona({ handle: 'beta' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id, b.id] });
  const [alpha, beta] = rt.sessionsIn(t.id);
  /** The asset tools as an agent calls them; each call’s answer, with its message checked to be a string. */
  const as = (se, turn = null, opts = {}) => {
    const tools = assetTools(rt, se.id, turn, opts);
    return Object.fromEntries(
      Object.entries(tools).map(([name, fn]) => [
        name,
        async (args) => {
          const r = await fn(args);
          if (typeof r.message !== 'string') throw new Error(`${name} answered without a message: ${JSON.stringify(r)}`);
          return r;
        },
      ]),
    );
  };
  return { rt, store: s, adapter, t, alpha, beta, folder, as, A: as(alpha), B: as(beta) };
}

/** The content between a read’s fences. @param {string} msg */
export function contentOf(msg) {
  const m = msg.match(/\n(`{3,})\n([\s\S]*?)\n\1(?:\n|$)/);
  if (!m) throw new Error(`No fenced content in: ${msg.slice(0, 300)}`);
  return m[2];
}

/** The arguments a part’s “reads on” line gives, or null on the last part. @param {string} msg */
export function readsOn(msg) {
  const m = msg.match(/read_asset (\{[^}]*\}) reads on\./);
  return m ? JSON.parse(m[1].replace(/(\w+):/g, '"$1":')) : null;
}
