// Always allow on a Read, Edit or Write card saved a rule that allowed nothing (tester’s gitpush runs, 8 Nov 2026): the
// rule was `Edit(/abs/file)`, and both Claude Code and Postbox’s own matcher read one leading slash as relative to the
// settings file’s folder. An absolute path needs two (`Edit(//abs/file)`). So each later edit of that file asked again,
// though the card said it wouldn’t. The once rule, passed as --allowedTools, had the same form. And Claude Code matches
// paths only in Read and Edit rules, so a Write, MultiEdit or NotebookEdit card now saves an Edit rule, which covers them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rulesFor } from '../server/permission-rules.mjs';
import { parseCall, ruleMatches } from '../shared/permission-match.mjs';

// The agent works in its folder, and Always allow saves into that folder’s .claude/settings.local.json, so a rule’s
// one leading slash starts there (permission-match.mjs, pathMatches).
const folder = '/work/agent';
const where = { cwd: folder, home: '/home/me', root: folder };
const TOOLS = [
  ['Read', 'file_path'],
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
];
const matches = (rule, tool, path) => ruleMatches(rule, parseCall(`${tool}(${path})`), where);

test('a path rule from a card matches the very file it was made for, inside the folder and outside it', () => {
  for (const [tool, field] of TOOLS)
    for (const path of [`${folder}/test_greet.py`, '/tmp/pb-x/notes.md', '/home/me/.config/x.json']) {
      const r = rulesFor(tool, { [field]: path });
      assert.ok(matches(r.always, tool, path), `${tool} always ${r.always} for ${path}`);
      assert.ok(matches(r.once, tool, path), `${tool} once ${r.once} for ${path}`);
    }
});

test('a path rule allows only its own file: not a sibling, not one in a folder of the same name elsewhere', () => {
  const r = rulesFor('Edit', { file_path: `${folder}/src/a.md` });
  assert.ok(!matches(r.always, 'Edit', `${folder}/src/b.md`));
  assert.ok(!matches(r.always, 'Edit', `${folder}${folder}/src/a.md`), 'not read as a path below the folder');
  assert.ok(!matches(r.always, 'Edit', '/elsewhere/work/agent/src/a.md'));
});

test('a path a rule can’t name exactly gets no rule: a glob character, or a ) that would end the rule early', () => {
  for (const path of [`${folder}/a*.md`, `${folder}/a?.md`, `${folder}/[ab].md`, `${folder}/a{b,c}.md`, `${folder}/a).md`]) {
    const r = rulesFor('Edit', { file_path: path });
    assert.equal(r.always, null, path);
    assert.equal(r.once, null, path);
  }
});

test('the rule names the file from the root, and an edit tool’s rule is an Edit rule', () => {
  assert.equal(rulesFor('Read', { file_path: '/p/a.md' }).always, 'Read(//p/a.md)');
  for (const tool of ['Edit', 'Write', 'MultiEdit']) assert.equal(rulesFor(tool, { file_path: '/p/a.md' }).always, 'Edit(//p/a.md)', tool);
  assert.equal(rulesFor('NotebookEdit', { notebook_path: '/p/n.ipynb' }).always, 'Edit(//p/n.ipynb)');
  assert.equal(rulesFor('Edit', { file_path: 'src/a.md' }).always, 'Edit(src/a.md)', 'a relative path stays relative');
});
