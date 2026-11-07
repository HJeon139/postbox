// #871: the permissions panel names every hook that could approve a tool call, or change its input, without the
// card, since `disableAllHooks` turns them all off in Postbox’s turns: a PreToolUse hook (permissionDecision,
// updatedInput) and a PermissionRequest hook (decision.behavior allow, updatedInput), as the Agent SDK’s types say
// (PreToolUseHookSpecificOutput and PermissionRequestHookSpecificOutput in sdk.d.ts). Each row says its event. The
// reader treats a PermissionRequest hook as it does a PreToolUse one: hostile text marked, credentials hidden, long
// text cut, and a shape it doesn’t know failing the whole file.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readHookFile, readHooks } from '../server/permission-hooks.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A settings file holding `content` as JSON. */
async function settings(content) {
  const file = join(tempDir('pb-hooks-events-'), 'settings.json');
  await writeFile(file, JSON.stringify(content));
  return file;
}
const command = (matcher, cmd) => ({ matcher, hooks: [{ type: 'command', command: cmd }] });

test('#871: a PermissionRequest hook is listed with its event, after the PreToolUse hooks, whatever order the file has', async () => {
  const file = await settings({ hooks: { PermissionRequest: [command('Bash', 'approve-bash')], PreToolUse: [command('Edit', 'check-edit')] } });
  assert.deepEqual(await readHookFile(file), {
    file,
    exists: true,
    hooks: [
      { event: 'PreToolUse', matcher: 'Edit', type: 'command', text: 'check-edit' },
      { event: 'PermissionRequest', matcher: 'Bash', type: 'command', text: 'approve-bash' },
    ],
    more: 0,
  });
});

test('#871: a PermissionRequest hook’s matcher and command are marked, redacted and cut as a PreToolUse one’s are', async () => {
  const file = await settings({
    hooks: {
      PermissionRequest: [
        command('Ba\u202esh|token=abc', 'API_KEY=sk-1 approve\u200b\u0000'),
        { hooks: [{ type: 'http', url: 'https://hooks.example/x?secret=s&v=1' }] },
        command('M'.repeat(500), 'x'.repeat(10_000)),
      ],
    },
  });
  assert.deepEqual((await readHookFile(file)).hooks, [
    { event: 'PermissionRequest', matcher: 'Ba\uFFFDsh|token=…', type: 'command', text: 'API_KEY=… approve\uFFFD\uFFFD' },
    { event: 'PermissionRequest', matcher: '*', type: 'http', text: 'https://hooks.example/x?secret=…&v=1' },
    { event: 'PermissionRequest', matcher: `${'M'.repeat(99)}…`, type: 'command', text: `${'x'.repeat(199)}…` },
  ]);
});

test('#871: PermissionRequest hooks in a shape it doesn’t know fail the whole file, PreToolUse hooks beside them included', async () => {
  for (const PermissionRequest of ['approve', null, {}, [null], [{ matcher: 'Bash', hooks: 'approve' }], [command('Bash', 'x'), 1]]) {
    const file = await settings({ hooks: { PreToolUse: [command('Edit', 'check-edit')], PermissionRequest } });
    assert.deepEqual(
      await readHookFile(file),
      { file, exists: true, hooks: [], more: 0, error: `${file} has hooks in a shape Postbox doesn’t know, so it can’t list them.` },
      JSON.stringify(PermissionRequest),
    );
  }
});

test('#871: hooks on events that can’t approve or change a tool call aren’t listed', async () => {
  const events = ['PostToolUse', 'PermissionDenied', 'UserPromptSubmit', 'Stop', 'SessionStart', 'Elicitation', 'PreModelSwitch'];
  const file = await settings({ hooks: Object.fromEntries(events.map((e) => [e, [command('*', `on ${e}`)]])) });
  assert.deepEqual(await readHookFile(file), { file, exists: true, hooks: [], more: 0 });
});

test('#871: the 50 listed per file count both events, and the rest are counted', async () => {
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => command('Bash', `${prefix} ${i}`));
  const file = await settings({ hooks: { PreToolUse: many(30, 'pre'), PermissionRequest: many(30, 'ask') } });
  const r = await readHookFile(file);
  assert.equal(r.hooks.length, 50);
  assert.deepEqual(r.hooks.at(29), { event: 'PreToolUse', matcher: 'Bash', type: 'command', text: 'pre 29' });
  assert.deepEqual(r.hooks.at(-1), { event: 'PermissionRequest', matcher: 'Bash', type: 'command', text: 'ask 19' });
  assert.equal(r.more, 10);
});

test('#871: each settings source an agent reads lists its PermissionRequest hooks', async () => {
  const root = tempDir('pb-hooks-events-');
  const folder = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(join(folder, '.claude'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PermissionRequest: [command('*', 'user approve')] } }));
  await writeFile(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PermissionRequest: [command('Bash', 'local approve')] } }));
  const listed = (files) => files.map((f) => [f.source, f.hooks.map((x) => `${x.event} ${x.text}`)]);
  assert.deepEqual(listed(await readHooks({ folder, home, usesHostSetup: true })), [
    ['user', ['PermissionRequest user approve']],
    ['project', []],
    ['local', ['PermissionRequest local approve']],
  ]);
});
