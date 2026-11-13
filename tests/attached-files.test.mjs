// The files the person attached to the message a turn delivers (#1307): each upload is stored in Postbox’s data
// folder, outside every agent’s folders, so each backend is let read exactly those files, with no card. Kiro can’t ask
// from Postbox, so without this its read was refused; Antigravity raised a card; Claude Code read it only where its
// Auto classifier let it (UAT runs attachimage and attachimage-compat, 13 November 2026).

import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool } from '../server/adapters/agy-hook.mjs';
import { agyHookVars } from '../server/adapters/antigravity-cli.mjs';
import { claudeArgs } from '../server/adapters/claude-code-args.mjs';
import { kiroRules } from '../server/adapters/kiro-cli-agent.mjs';
import { fromContext } from '../server/adapters/setup.mjs';
import { Blobs } from '../server/blobs.mjs';
import { hostName } from '../server/remote/attachments.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

/**
 * A room whose @alpha is sent a message with one upload, of this name and type, stored in a real blob store; resolves
 * to the turn’s ctx and the upload’s stored path.
 */
async function uploaded({ name, type }) {
  const r = setup();
  r.rt.blobs = new Blobs(tempDir('pb-blobs-'));
  const { sha256 } = await r.rt.blobs.put(Buffer.from(`${name} bytes`));
  r.store.emit('file', { id: 'fi_pic', name, type, size: 9, sha256, at: 1 });
  let ctx;
  r.adapter.next.push(async (c) => {
    ctx = c;
    c.text('ok');
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha what is this?', attachments: [{ kind: 'file', fileId: 'fi_pic' }] });
  await settle(r.rt);
  return { ctx, blob: r.rt.blobs.pathOf(sha256) };
}
const attachedTurn = async () => {
  const { ctx } = await uploaded({ name: 'picture.png', type: 'image/png' });
  return { ctx, path: ctx.readFiles[0] };
};

test('#1307 a turn’s context lists a path to each file attached to the message it delivers, holding its bytes', async () => {
  const { ctx, blob } = await uploaded({ name: 'picture.png', type: 'image/png' });
  assert.equal(ctx.readFiles.length, 1);
  assert.deepEqual(readFileSync(ctx.readFiles[0]), readFileSync(blob));
});

test('#1307 Claude Code and the Agent SDK may read each attached file with no card: an allow rule for its absolute path', async () => {
  const { ctx, path } = await attachedTurn();
  const args = claudeArgs({ persona: ctx.persona, sessionId: 's', resume: false, guide: 'g', ...fromContext(ctx, '/mem') });
  assert.ok(args.includes(`Read(/${path})`), `no Read(/${path}) in ${args.join(' ')}`);
  assert.ok(!args.some((a) => /^(Edit|Write)\(/.test(a)), 'reading, never editing');
});

test('#1307 Kiro may read each attached file, and only read it', () => {
  const rules = kiroRules({ persona: { permissionMode: 'ask' }, folders: ['/work'], reads: ['/data/blobs/ab/cdef'], resolve: false });
  assert.ok(rules.some((r) => r.capability === 'fs_read' && r.effect === 'allow' && r.match.includes('/data/blobs/ab/cdef')));
  assert.ok(!rules.some((r) => r.capability === 'fs_write' && r.match.includes('/data/blobs/ab/cdef')));
});

test('#1307 Antigravity’s hook reads an attached file with no card, in every mode, and still asks to edit it', () => {
  const home = realpathSync(tempDir('pb-agy-attach-'));
  const ws = join(home, 'ws');
  const file = join(home, 'data-blob');
  writeFileSync(file, 'x');
  const vars = agyHookVars({ mcpUrl: 'http://x/mcp', persona: { permissionMode: 'ask' }, cwd: ws, addDirs: [], reads: [file] });
  const reads = JSON.parse(vars.POSTBOX_AGY_READS);
  for (const mode of ['ask', 'acceptEdits', 'auto']) {
    const opts = { mode, folders: [ws], reads, cwd: ws, home };
    assert.equal(decideAgyTool({ toolCall: { name: 'view_file', args: { AbsolutePath: file } } }, opts).decision, 'allow', mode);
    assert.equal(decideAgyTool({ toolCall: { name: 'write_to_file', args: { TargetFile: file } } }, opts).decision, 'ask', mode);
  }
});

test('#1307 an attached image’s path ends in its type’s extension, and holds its bytes, so a backend that reads images by extension opens it', async () => {
  const { ctx, blob } = await uploaded({ name: 'image', type: 'image/png' });
  const [path] = ctx.readFiles;
  assert.match(path, /\.png$/);
  assert.notEqual(path, blob);
  assert.deepEqual(readFileSync(path), readFileSync(blob));
});

test('#1307 an upload with no known type keeps its name’s extension, and one with neither is read at its stored path', async () => {
  assert.match((await uploaded({ name: 'notes.CSV', type: 'application/octet-stream' })).ctx.readFiles[0], /\.CSV$/);
  const { ctx, blob } = await uploaded({ name: 'README', type: 'application/octet-stream' });
  assert.deepEqual(ctx.readFiles, [blob]);
});

test('#1307 a host’s copy of an attached image takes its type’s extension when its name has none', () => {
  assert.equal(hostName({ kind: 'file', name: 'image', type: 'image/png' }, 0), '1-image.png');
  assert.equal(hostName({ kind: 'file', name: 'chart.png', type: 'image/png' }, 1), '2-chart.png');
});
