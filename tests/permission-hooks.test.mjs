// #817: the permissions panel names each PreToolUse hook in the settings files an agent reads, since Postbox’s own
// settings turn them off in every mode but bypass. A hook’s matcher and command are the person’s data, shown as text:
// each test gives the reader hostile or broken input and checks the exact strings it hands the panel.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { readHookFile, readHooks } from '../server/permission-hooks.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A settings file holding `content` (a string as written, anything else as JSON). */
async function settings(content) {
  const dir = tempDir('pb-hooks-');
  const file = join(dir, 'settings.json');
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
const pre = (...groups) => ({ hooks: { PreToolUse: groups } });
const command = (matcher, cmd) => ({ matcher, hooks: [{ type: 'command', command: cmd }] });

test('#817: a hook command with quotes, angle brackets and ampersands is listed exactly as written, as text', async () => {
  const cmd = 'echo "<img src=x onerror=alert(1)>" &amp; && printf \'{"a":1}\' > /tmp/x';
  const file = await settings(pre(command('Bash', cmd)));
  assert.deepEqual(await readHookFile(file), { file, exists: true, hooks: [{ matcher: 'Bash', type: 'command', text: cmd }], more: 0 });
});

test('#817: a NUL or another control character in a hook shows as a replacement mark, and a line break as a space', async () => {
  const file = await settings(pre(command('Ba\u0000sh', 'touch a\u0000b\nnext\tone\u001b[31m\u007f')));
  assert.deepEqual((await readHookFile(file)).hooks, [{ matcher: 'Ba\uFFFDsh', type: 'command', text: 'touch a\uFFFDb next one\uFFFD[31m\uFFFD' }]);
});

test('#817: bidi and zero-width characters in a hook show as a replacement mark, so they can’t reorder or hide its text', async () => {
  // A right-to-left override would show `rm -rf ~ #txt.exe` as something else; a zero-width space hides between letters.
  const marks = '\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff';
  const file = await settings(pre(command('Ba\u200bsh', `echo safe\u202e#exe.txt${marks}\u2028next\u2029end`)));
  assert.deepEqual((await readHookFile(file)).hooks, [
    { matcher: 'Ba\uFFFDsh', type: 'command', text: `echo safe\uFFFD#exe.txt${'\uFFFD'.repeat(15)} next end` },
  ]);
});

test('#817: a C1 control character in a hook shows as a replacement mark, as a C0 one does', async () => {
  // U+0085 is a next line and U+009B a control sequence introducer: a terminal reads both, and the page shows neither.
  const file = await settings(pre(command('Ba\u0080sh', 'echo a\u0085b\u009b31mc\u009f')));
  assert.deepEqual((await readHookFile(file)).hooks, [{ matcher: 'Ba\uFFFDsh', type: 'command', text: 'echo a\uFFFDb\uFFFD31mc\uFFFD' }]);
});

// Each of these displays as nothing, or as a blank, so it could hide inside a command that reads as another one.
const blanks = [
  ['U+00AD soft hyphen', '\u00ad'],
  ['U+034F combining grapheme joiner', '\u034f'],
  ['U+061C Arabic letter mark', '\u061c'],
  ['U+180E Mongolian vowel separator', '\u180e'],
  ['U+2060 word joiner', '\u2060'],
  ['U+2061 function application', '\u2061'],
  ['U+2062 invisible times', '\u2062'],
  ['U+2063 invisible separator', '\u2063'],
  ['U+2064 invisible plus', '\u2064'],
  ['U+3164 Hangul filler', '\u3164'],
  ['U+FE0F variation selector 16', '\ufe0f'],
  ['U+E0000, unassigned in the tag block', '\u{e0000}'],
  ['U+E0001 language tag', '\u{e0001}'],
  ['U+E0041 tag Latin capital A', '\u{e0041}'],
  ['U+E007F cancel tag', '\u{e007f}'],
];
for (const [name, mark] of blanks) {
  test(`#817: ${name} in a hook shows as a replacement mark`, async () => {
    const file = await settings(pre(command(`Ba${mark}sh`, `rm -rf ~${mark}/tmp/x`)));
    assert.deepEqual((await readHookFile(file)).hooks, [{ matcher: 'Ba\uFFFDsh', type: 'command', text: 'rm -rf ~\uFFFD/tmp/x' }]);
  });
}

test('#817: a very long command or matcher is cut, with an ellipsis at the cut', async () => {
  const file = await settings(pre(command('M'.repeat(500), 'x'.repeat(100_000))));
  assert.deepEqual((await readHookFile(file)).hooks, [{ matcher: `${'M'.repeat(99)}…`, type: 'command', text: `${'x'.repeat(199)}…` }]);
});

test('#817: a command or matcher exactly at its limit isn’t cut', async () => {
  const file = await settings(pre(command('M'.repeat(100), 'x'.repeat(200))));
  assert.deepEqual((await readHookFile(file)).hooks, [{ matcher: 'M'.repeat(100), type: 'command', text: 'x'.repeat(200) }]);
});

test('#817: a hook type past 20 characters is cut, with an ellipsis at the cut', async () => {
  const file = await settings(pre({ matcher: 'Bash', hooks: [{ type: 't'.repeat(500), command: 'x' }] }));
  assert.deepEqual((await readHookFile(file)).hooks, [{ matcher: 'Bash', type: `${'t'.repeat(19)}…`, text: 'x' }]);
});

test('#817: a hook with both a command and a prompt shows its command, as Claude Code runs a command hook', async () => {
  const file = await settings(pre({ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit', prompt: 'Is this safe?', url: 'http://x' }] }));
  assert.deepEqual((await readHookFile(file)).hooks, [{ matcher: 'Bash', type: 'command', text: 'audit' }]);
});

test('#817: a hook that isn’t an object (null, a string) is listed as a command hook with no text, and doesn’t throw', async () => {
  const file = await settings(pre({ matcher: 'Bash', hooks: [null, 'touch /tmp/pwned'] }));
  assert.deepEqual((await readHookFile(file)).hooks, [
    { matcher: 'Bash', type: 'command', text: '' },
    { matcher: 'Bash', type: 'command', text: '' },
  ]);
});

test('#817: PreToolUse hooks that aren’t a list say the file’s hooks can’t be listed, and list none', async () => {
  for (const content of [
    { hooks: { PreToolUse: 'touch /tmp/pwned' } },
    { hooks: ['PreToolUse'] },
    pre({ matcher: 'Bash', hooks: 'touch /tmp/pwned' }),
    pre(null),
    // One group it knows beside one it doesn’t: the file can’t be listed, rather than listed in part.
    pre(command('Bash', 'x'), null),
  ]) {
    const file = await settings(content);
    assert.deepEqual(await readHookFile(file), {
      file,
      exists: true,
      hooks: [],
      more: 0,
      error: `${file} has hooks in a shape Postbox doesn’t know, so it can’t list them.`,
    });
  }
});

test('#817: a settings file that isn’t valid JSON says so, and doesn’t throw', async () => {
  const file = await settings('{ "hooks": { "PreToolUse": [');
  assert.deepEqual(await readHookFile(file), { file, exists: true, hooks: [], more: 0, error: `${file} isn’t valid JSON, so Postbox can’t list its hooks.` });
});

test('#817: a settings file that can’t be read (a folder) says why, and doesn’t throw', async () => {
  const dir = tempDir('pb-hooks-');
  assert.deepEqual(await readHookFile(dir), {
    file: dir,
    exists: true,
    hooks: [],
    more: 0,
    error: `Postbox couldn’t read ${dir} (EISDIR), so it can’t list its hooks.`,
  });
});

test('#817: a missing file, a file without hooks and other events list no PreToolUse hooks, with no error', async () => {
  const missing = join(tempDir('pb-hooks-'), 'settings.json');
  assert.deepEqual(await readHookFile(missing), { file: missing, exists: false, hooks: [], more: 0 });
  for (const content of [{}, null, [], { hooks: { PostToolUse: [command('*', 'echo after')] } }]) {
    const file = await settings(content);
    assert.deepEqual(await readHookFile(file), { file, exists: true, hooks: [], more: 0 });
  }
});

test('#817: a hook with no matcher matches every tool, and a hook of another type shows its prompt or address', async () => {
  const file = await settings(
    pre(
      { hooks: [{ type: 'command', command: 'audit' }] },
      { matcher: 'Edit', hooks: [{ type: 'prompt', prompt: 'Is this safe?' }, { type: 'http', url: 'http://x' }, {}] },
    ),
  );
  assert.deepEqual((await readHookFile(file)).hooks, [
    { matcher: '*', type: 'command', text: 'audit' },
    { matcher: 'Edit', type: 'prompt', text: 'Is this safe?' },
    { matcher: 'Edit', type: 'http', text: 'http://x' },
    { matcher: 'Edit', type: 'command', text: '' },
  ]);
});

test('#817: a file with more than 50 hooks lists 50 and counts the rest', async () => {
  const file = await settings(pre(...Array.from({ length: 60 }, (_, i) => command('Bash', `hook ${i}`))));
  const r = await readHookFile(file);
  assert.equal(r.hooks.length, 50);
  assert.equal(r.hooks.at(-1).text, 'hook 49');
  assert.equal(r.more, 10);
});

test('#817: the hooks come from user, project and local settings, and an Isolated persona’s from project and local only', async () => {
  const root = tempDir('pb-hooks-');
  const folder = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(join(folder, '.claude'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify(pre(command('*', 'user hook'))));
  await writeFile(join(folder, '.claude', 'settings.json'), JSON.stringify(pre(command('Bash', 'project hook'))));
  await writeFile(join(folder, '.claude', 'settings.local.json'), '{');
  const listed = (files) => files.map((f) => [f.source, f.hooks.map((x) => x.text), f.error ?? null]);
  const local = `${join(folder, '.claude', 'settings.local.json')} isn’t valid JSON, so Postbox can’t list its hooks.`;
  assert.deepEqual(listed(await readHooks({ folder, home, usesHostSetup: true })), [
    ['user', ['user hook'], null],
    ['project', ['project hook'], null],
    ['local', [], local],
  ]);
  assert.deepEqual(listed(await readHooks({ folder, home, usesHostSetup: false })), [
    ['project', ['project hook'], null],
    ['local', [], local],
  ]);
  // CLAUDE_CONFIG_DIR is where Claude Code reads the user settings from instead.
  assert.equal((await readHooks({ folder, home, configDir: join(root, 'cfg'), usesHostSetup: true }))[0].file, join(root, 'cfg', 'settings.json'));
});

test('#817: the panel’s view lists the hooks of each settings file the agent reads, and an Isolated one’s without the user’s', async () => {
  const root = tempDir('pb-hooks-');
  const folder = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(join(folder, '.claude'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify(pre(command('Bash', 'user-check'))));
  await writeFile(join(folder, '.claude', 'settings.json'), JSON.stringify(pre(command('Bash', 'project-check'))));
  const store = new Store(null);
  const adapter = { name: 'claude-code', folderFor: async () => folder, deliver: async () => {} };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'auto' });
  const se = rt.sessionsIn(rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] }).id)[0];
  const hooks = async () => (await rt.permissionsView({ sessionId: se.id })).hooks.map((f) => [f.source, f.hooks.map((x) => x.text)]);
  assert.deepEqual(await hooks(), [
    ['user', ['user-check']],
    ['project', ['project-check']],
    ['local', []],
  ]);
  rt.updatePersona(p.id, { usesHostSetup: false });
  assert.deepEqual(await hooks(), [
    ['project', ['project-check']],
    ['local', []],
  ]);
});

test('#817: the panel’s view lists no hooks, and doesn’t throw, for a persona with no folder, a backend that doesn’t read rules, or the mock', async () => {
  const root = tempDir('pb-hooks-');
  const folder = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(join(folder, '.claude'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify(pre(command('Bash', 'user-check'))));
  await writeFile(join(folder, '.claude', 'settings.json'), JSON.stringify(pre(command('Bash', 'project-check'))));
  const store = new Store(null);
  const deliver = async () => {};
  const adapters = new AdapterRegistry()
    .register({ name: 'claude-code', folderFor: async () => null, deliver })
    .register({ name: 'kiro', capabilities: { permissions: 'none' }, folderFor: async () => folder, deliver })
    .register({ name: 'mock', folderFor: async () => folder, deliver });
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({ store, adapters, corpus, config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home } });
  store.emit('project', { id: 'p1', name: 'P', folder });
  for (const backend of ['claude-code', 'kiro', 'mock']) {
    const p = rt.createPersona({ handle: `a-${backend}`, backend, permissionMode: 'auto' });
    const se = rt.sessionsIn(rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] }).id)[0];
    assert.deepEqual((await rt.permissionsView({ sessionId: se.id })).hooks, [], backend);
  }
});
