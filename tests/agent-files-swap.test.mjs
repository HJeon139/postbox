// A file an agent names is read from what Postbox opened, not from its path again (#780): agentFile checks the path,
// opens it without following a link at its end, and checks the open file is still the one it checked. Each test
// swaps a file or a folder for a link at one step, through agentFile’s test hooks, so the race is deterministic.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { AgentFileError, agentFile } from '../server/agent-files.mjs';
import { Blobs } from '../server/blobs.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX = 1024;

/** A folder the agent works in, with a file, and a folder outside it with a secret of the same name. */
async function folders() {
  const root = await mkdtemp(join(tmpdir(), 'pb-agent-file-swap-'));
  const folder = join(root, 'work');
  const outside = join(root, 'outside');
  await mkdir(join(folder, 'sub'), { recursive: true });
  await mkdir(join(outside, 'sub'), { recursive: true });
  await writeFile(join(folder, 'f.txt'), 'mine');
  await writeFile(join(folder, 'sub', 'f.txt'), 'mine');
  await writeFile(join(outside, 'secret.txt'), 'not yours');
  await writeFile(join(outside, 'sub', 'f.txt'), 'not yours');
  /** The part of a Runtime agentFile uses: the agent’s folders. */
  const rt = { agentFolders: async () => [folder] };
  return { rt, folder, outside };
}

/** Replaces a file or folder with a link to another, in two renames, as an agent racing Postbox could. */
async function swapForLink(at, target) {
  await rename(at, `${at}.was`);
  await symlink(target, at);
}

test('#780: a path outside the agent’s folders is refused as outside them', async () => {
  const { rt, outside } = await folders();
  for (const path of ['../outside/secret.txt', join(outside, 'secret.txt')])
    await assert.rejects(() => agentFile(rt, 's', path, MAX, 'codePath'), {
      message: `${path} is outside your folders, so Postbox didn’t read it (codePath).`,
    });
});

test('#780: a link in the agent’s folder that leads outside it is refused, saying it leads outside', async () => {
  const { rt, folder, outside } = await folders();
  await symlink(join(outside, 'secret.txt'), join(folder, 'link.txt'));
  await assert.rejects(() => agentFile(rt, 's', 'link.txt', MAX, 'codePath'), {
    message: 'link.txt leads outside your folders, so Postbox didn’t read it (codePath).',
  });
});

test('#780: a file swapped for a link after its path was checked is refused at the open', async () => {
  const { rt, folder, outside } = await folders();
  let opened = false;
  const hooks = {
    afterCheck: () => swapForLink(join(folder, 'f.txt'), join(outside, 'secret.txt')),
    afterOpen: () => {
      opened = true;
    },
  };
  await assert.rejects(
    () => agentFile(rt, 's', 'f.txt', MAX, 'codePath', hooks),
    (e) => e instanceof AgentFileError && /changed while Postbox read it/.test(e.message),
  );
  assert.equal(opened, false, 'the open itself refused the link');
});

test('#780: a folder on the path swapped for a link to an outside folder after the check is refused', async () => {
  const { rt, folder, outside } = await folders();
  let read = false;
  const hooks = {
    afterCheck: () => swapForLink(join(folder, 'sub'), join(outside, 'sub')),
    beforeRead: () => {
      read = true;
    },
  };
  await assert.rejects(() => agentFile(rt, 's', 'sub/f.txt', MAX, 'codePath', hooks), {
    message: 'sub/f.txt changed while Postbox read it, so Postbox didn’t read it (codePath). Try again once it’s settled.',
  });
  assert.equal(read, false, 'nothing was read from the outside file');
});

test('#780: a folder swapped for a link and back again around the open is refused, since the file opened isn’t the one there', async () => {
  const { rt, folder, outside } = await folders();
  const sub = join(folder, 'sub');
  const hooks = {
    afterCheck: () => swapForLink(sub, join(outside, 'sub')),
    // The path names the agent’s own file again, but the open one is outside.
    afterOpen: async () => {
      await rename(sub, `${sub}.link`);
      await mkdir(sub);
      await writeFile(join(sub, 'f.txt'), 'mine');
    },
  };
  await assert.rejects(() => agentFile(rt, 's', 'sub/f.txt', MAX, 'codePath', hooks), /changed while Postbox read it/);
});

test('#780: what’s read is the file Postbox opened and checked, even if its path becomes a link after that', async () => {
  const { rt, folder, outside } = await folders();
  const hooks = { beforeRead: () => swapForLink(join(folder, 'f.txt'), join(outside, 'secret.txt')) };
  assert.equal((await agentFile(rt, 's', 'f.txt', MAX, 'codePath', hooks)).toString(), 'mine');
});

test('#780: a file over the limit is refused before any of it is read', async () => {
  const { rt, folder } = await folders();
  await writeFile(join(folder, 'big.txt'), 'x'.repeat(MAX + 1));
  let read = false;
  const hooks = {
    beforeRead: () => {
      read = true;
    },
  };
  await assert.rejects(() => agentFile(rt, 's', 'big.txt', MAX, 'codePath', hooks), { message: 'big.txt is over the limit for codePath.' });
  assert.equal(read, false);
  assert.equal((await agentFile(rt, 's', 'f.txt', MAX, 'codePath')).toString(), 'mine', 'a file within it reads');
});

// ── show_app, agentFile’s second caller ────────────────────────────────────────────

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

/** A Runtime whose agent works in folder, and a call of a tool over MCP from inside one of its turns. */
async function showApp(folder, root) {
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
  const call = async (name, args) => {
    let out = null;
    adapter.next.push(async (c) => {
      const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
      out = await handleMcp(rt, se.id, msg, new URL(c.mcpUrl).searchParams.get('turn'));
    });
    rt.sendMessage(t.id, { text: 'go' });
    for (let i = 0; i < 100 && (out === null || rt.turns.size); i++) await sleep(5);
    return { text: out.result?.content?.[0]?.text ?? out.error?.message, isError: out.result?.isError ?? true };
  };
  return { rt, call };
}

test('#780: show_app still reads a codePath and a data file from the agent’s folder', async () => {
  const { folder } = await folders();
  await writeFile(join(folder, 'app.html'), '<p>from a file</p>');
  const { rt, call } = await showApp(folder, join(folder, '..'));
  const r = await call('show_app', { id: 'ok', title: 'OK', codePath: 'app.html', files: [{ name: 'data', path: 'f.txt' }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(rt.s.apps.ok.versions[0].code, '<p>from a file</p>');
  assert.equal((await rt.appFile('ok', 'data')).toString(), 'mine');
});

test('#780: show_app refuses a data file swapped for a link after its path was checked', async () => {
  const { folder, outside } = await folders();
  await writeFile(join(folder, 'app.html'), '<p>x</p>');
  const { rt, call } = await showApp(folder, join(folder, '..'));
  // show_app reads its files through rt.agentFile; this one swaps the data file once its path is checked.
  rt.agentFile = (sessionId, path, max, what) =>
    agentFile(rt, sessionId, path, max, what, {
      afterCheck: () => (path === 'f.txt' ? swapForLink(join(folder, 'f.txt'), join(outside, 'secret.txt')) : undefined),
    });
  const r = await call('show_app', { id: 'x', title: 'X', codePath: 'app.html', files: [{ name: 'data', path: 'f.txt' }] });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /f\.txt changed while Postbox read it/);
  assert.equal(rt.s.apps.x, undefined, 'nothing was shown');
});
