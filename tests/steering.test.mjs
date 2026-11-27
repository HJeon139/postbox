// #319: an agent working in Postbox’s data folder inside a clone doesn’t load the clone’s own AGENTS.md, and one whose
// folder is the checkout, or is anywhere outside the data folder, does (server/adapters/steering.mjs).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { claudeArgs } from '../server/adapters/claude-code-args.mjs';
import { CodexAdapter, codexSteeringArgs } from '../server/adapters/codex.mjs';
import { checkoutSteering, withSteering } from '../server/adapters/steering.mjs';
import { remoteCtx, starts } from './claude-code-remote-fixture.mjs';
import { fakeAppServer } from './codex-fixture.mjs';
import { createFakeDaemon, fixtureLines } from './fake-daemon.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A clone with a store in data/: its AGENTS.md, a workspace, a project in data/, and its own steering there. */
function clone() {
  const root = tempDir('pb-steering-');
  const checkout = join(root, 'postbox');
  const data = join(checkout, 'data');
  for (const d of [join(data, 'workspaces', 'dev'), join(data, 'research'), join(checkout, 'server'), join(checkout, '.git')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(checkout, 'AGENTS.md'), '# Working on Postbox\n');
  writeFileSync(join(checkout, 'package.json'), '{ "name": "postbox" }\n');
  writeFileSync(join(data, 'research', 'AGENTS.md'), '# The person’s own steering\n');
  return { root, checkout, data };
}

test('#319 an agent in the data folder inside a clone is kept from the checkout’s AGENTS.md, and from no file of its own', () => {
  const { checkout, data } = clone();
  for (const folder of [join(data, 'workspaces', 'dev'), join(data, 'research')]) {
    const out = checkoutSteering(folder, data);
    assert.ok(out.includes(join(checkout, 'AGENTS.md')), folder);
    assert.ok(out.includes(join(checkout, '.claude', 'AGENTS.md')), folder);
    // And what Claude Code loads beside it, should a developer add one to their clone.
    for (const f of ['CLAUDE.md', 'CLAUDE.local.md', join('.claude', 'CLAUDE.md')]) assert.ok(out.includes(join(checkout, f)), `${f} in ${folder}`);
    assert.ok(!out.some((p) => p.startsWith(`${data}/`) || p === join(data, 'AGENTS.md')), `nothing in the data folder: ${out}`);
    // Each by the checkout’s path as given, or through its links (a temp folder’s, on macOS).
    assert.ok(
      out.every((p) => [checkout, realpathSync(checkout)].some((c) => p.startsWith(`${c}/`))),
      `nothing above the checkout: ${out}`,
    );
  }
});

test('#319 a project at the checkout, or elsewhere in it, still gets the checkout’s AGENTS.md', () => {
  const { checkout, data } = clone();
  assert.deepEqual(checkoutSteering(checkout, data), []);
  assert.deepEqual(checkoutSteering(join(checkout, 'server'), data), []);
});

test('#319 a data folder in no repository, as ~/.postbox is, keeps nothing from anyone', () => {
  const { root } = clone();
  const home = join(root, 'home-postbox');
  mkdirSync(join(home, 'workspaces', 'dev'), { recursive: true });
  assert.deepEqual(checkoutSteering(join(home, 'workspaces', 'dev'), home), []);
  // Nor a home folder kept in git that holds it: that repository isn’t a Postbox checkout.
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'AGENTS.md'), '# The person’s own\n');
  assert.deepEqual(checkoutSteering(join(home, 'workspaces', 'dev'), home), []);
});

test('#319 a clone whose data/ links to the data folder elsewhere: an agent there by the link’s path is kept from it', () => {
  const { root } = clone();
  const checkout = join(root, 'moved');
  const home = join(root, 'home-postbox');
  mkdirSync(join(home, 'research'), { recursive: true });
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, 'AGENTS.md'), '# Working on Postbox\n');
  writeFileSync(join(checkout, 'package.json'), '{ "name": "postbox" }\n');
  symlinkSync(home, join(checkout, 'data'));
  // The folder by the link’s path walks up through the checkout; by its own path it never reaches it.
  assert.ok(checkoutSteering(join(checkout, 'data', 'research'), join(checkout, 'data')).includes(join(checkout, 'AGENTS.md')));
  assert.deepEqual(checkoutSteering(join(home, 'research'), join(checkout, 'data')), []);
});

test('#319 a data folder given by a link outside the clone is matched through the link to the checkout', () => {
  const { root, checkout, data } = clone();
  const link = join(root, 'pb-link');
  symlinkSync(data, link);
  // By the link’s own path no repository is above it: only its real path reaches the checkout.
  const out = checkoutSteering(join(link, 'workspaces', 'dev'), link);
  assert.ok(out.includes(join(realpathSync.native(checkout), 'AGENTS.md')), JSON.stringify(out));
});

test('#319 the checkout’s rules are listed by their paths, which hold no glob, even under a folder named like one', () => {
  const root = tempDir('pb-steering-');
  const checkout = join(root, 'postbox (copy)');
  const data = join(checkout, 'data');
  mkdirSync(join(data, 'workspaces', 'dev'), { recursive: true });
  mkdirSync(join(checkout, '.git'));
  mkdirSync(join(checkout, '.claude', 'rules', 'more'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), '{ "name": "postbox" }\n');
  writeFileSync(join(checkout, '.claude', 'rules', 'style.md'), '# Rules\n');
  writeFileSync(join(checkout, '.claude', 'rules', 'more', 'tests.md'), '# Rules\n');
  const out = checkoutSteering(join(data, 'workspaces', 'dev'), data);
  for (const f of ['style.md', join('more', 'tests.md')]) assert.ok(out.includes(join(checkout, '.claude', 'rules', f)), `${f}: ${out}`);
  assert.ok(!out.some((p) => p.includes('*')), `no glob: ${out}`);
});

test('#319 the excludes reach the turn’s settings, beside the persona’s own, and none leave the settings as they were', () => {
  const kept = withSteering({ claudeMdExcludes: ['/x/AGENTS.md'], a: 1 }, ['/y/AGENTS.md']);
  assert.deepEqual(kept, { claudeMdExcludes: ['/x/AGENTS.md', '/y/AGENTS.md'], a: 1 });
  const same = { a: 1 };
  assert.equal(withSteering(same, []), same);
  const args = claudeArgs({ persona: { handle: 'dev' }, sessionId: 's', resume: false, guide: 'g', claudeMdExcludes: ['/c/AGENTS.md'] });
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.claudeMdExcludes, ['/c/AGENTS.md']);
});

/** A recorded Claude Code stream (tests/fixtures/claude-code/block.jsonl), played to the adapter as its CLI’s output. */
const recorded = readFileSync(new URL('fixtures/claude-code/block.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n');

/** A turn’s context for a persona with no folder of its own, in a project with none. */
function ctxFor() {
  const abort = new AbortController();
  return {
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { handle: 'dev', model: 'claude-opus-5-5', permissionMode: 'auto', folder: null, description: '', instructions: '' },
    project: null,
    handles: ['dev'],
    state: {},
    saveState: () => {},
    pathOf: () => null,
    text: () => {},
    activity: () => {},
    status: () => {},
    compaction: () => {},
    denied: () => {},
  };
}

test('#319 a Claude Code turn from a persona with no folder, in a clone’s data folder, runs without the clone’s AGENTS.md', async () => {
  const { checkout, data } = clone();
  /** @type {string[][]} */
  const runs = [];
  const spawnImpl = (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
    runs.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
    setImmediate(() => {
      for (const l of recorded) child.stdout.write(`${l}\n`);
      child.stdout.end();
      setTimeout(() => child.emit('close', 0), 10);
    });
    return child;
  };
  await new ClaudeCodeAdapter({ bin: 'claude', workRoot: join(data, 'workspaces'), spawnImpl }).deliver({}, { kind: 'user', text: 'Hi' }, ctxFor());
  const settings = JSON.parse(runs[0][runs[0].indexOf('--settings') + 1]);
  assert.ok(settings.claudeMdExcludes?.includes(join(checkout, 'AGENTS.md')), JSON.stringify(settings.claudeMdExcludes));
});

test('#319 a turn on a host is given none: its folder is the host’s, and this computer’s paths never cross', async () => {
  const { data } = clone();
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  // A host folder spelled as this computer’s data folder: it still names no file here.
  const ctx = remoteCtx(d, { remote: { folder: join(data, 'workspaces', 'dev') } });
  await new ClaudeCodeAdapter({ bin: 'claude', workRoot: join(data, 'workspaces') }).deliver({}, { kind: 'user', text: 'Hi' }, ctx);
  const [start] = starts(d);
  const settings = JSON.parse(start.argv[start.argv.indexOf('--settings') + 1]);
  assert.equal(settings.claudeMdExcludes, undefined, JSON.stringify(settings));
});

// Codex (#319): it loads AGENTS.md from the nearest folder holding a root marker down to its working folder, `.git` by
// default (Codex 0.167.0, `project_root_markers`). Measured without a model turn (thread/start’s instructionSources):
// with `postbox.lock`, which Postbox keeps in its data folder, as a marker too, an agent in the data folder loads the
// data folder’s and its own AGENTS.md and not the checkout’s, and the checkout itself still loads it.

test('#319 Codex: an agent in the data folder inside a clone stops its AGENTS.md walk at the data folder', () => {
  const { checkout, data } = clone();
  for (const folder of [join(data, 'workspaces', 'dev'), join(data, 'research')])
    assert.deepEqual(codexSteeringArgs(folder, data), ['-c', 'project_root_markers=[".git","postbox.lock"]'], folder);
  assert.deepEqual(codexSteeringArgs(checkout, data), [], 'the checkout itself keeps its rules');
  assert.deepEqual(codexSteeringArgs(join(checkout, 'server'), data), []);
});

test('#319 Codex: a data folder in no repository, or a project under the clone’s data/ while the data folder is elsewhere, is left as it is', () => {
  const { data } = clone();
  const home = tempDir('pb-steering-home-');
  mkdirSync(join(home, 'workspaces', 'dev'), { recursive: true });
  assert.deepEqual(codexSteeringArgs(join(home, 'workspaces', 'dev'), home), []);
  // The person’s decision of 27 November: a project folder in <clone>/data is left alone when the data folder isn’t it.
  assert.deepEqual(codexSteeringArgs(join(data, 'research'), home), []);
});

test('#319 Codex: a turn in the data folder inside a clone starts the app-server with the data folder as a root', async () => {
  const { data } = clone();
  // An agent with no folder, in a workspace, and one whose project is in the data folder (the issue’s own case).
  for (const project of [null, { folder: join(data, 'research') }]) {
    /** @type {string[][]} */
    const seen = [];
    const adapter = new CodexAdapter({
      workRoot: join(data, 'workspaces'),
      spawnImpl: (_bin, args) => {
        seen.push(args);
        return fakeAppServer([]);
      },
    });
    const ctx = {
      persona: { handle: 'dev', model: 'gpt-5.6-terra', effort: 'medium', permissionMode: 'acceptEdits' },
      project,
      handles: ['dev'],
      state: {},
      signal: new AbortController().signal,
      mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
      text: () => {},
      activity: () => {},
      status: () => {},
      saveState: () => {},
      checkpoint: () => {},
      pathOf: () => null,
    };
    await adapter.deliver({}, { kind: 'user', text: 'Say hello.' }, ctx);
    const i = seen[0].indexOf('project_root_markers=[".git","postbox.lock"]');
    assert.ok(i > 0 && seen[0][i - 1] === '-c', `${JSON.stringify(project)}: ${seen[0].join(' ')}`);
  }
});
