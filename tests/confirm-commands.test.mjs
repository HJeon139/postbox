// #852 slice 1a: a confirm names the commands that run when the person confirms, in its own commands field. A
// confirmed command runs with no second card, so the person must see every byte of it: an entry with a character
// that draws as nothing, a run of spaces or a line too long to read is refused, with the reason, before it’s shown.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { validateBlock } from '../shared/catalog.mjs';
import { commandProblem } from '../shared/confirm-commands.mjs';

const confirm = (commands) => ({
  id: 'push',
  type: 'confirm',
  version: 1,
  fallback: 'Push the branch?',
  statement: 'Push the branch to origin?',
  confirmLabel: 'Push',
  commands,
});
const errorsOf = (commands) => {
  const r = validateBlock(confirm(commands));
  assert.equal(r.ok, false, 'expected the confirm to be refused');
  return r.errors;
};

const PUSH = 'git push origin wip/852-field';
const LONG = 'gh pr edit 896 --repo owner/postbox --add-label "ready for integrator" --remove-label "changes requested"';

test('a confirm with one to three of the shapes passes', () => {
  const third = 'gh issue comment 12 --repo owner/postbox --body-file /tmp/pb-x/b.md';
  for (const commands of [[PUSH], [PUSH, LONG], [PUSH, LONG, third]]) {
    const r = validateBlock(confirm(commands));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  }
  assert.equal(commandProblem(LONG), null);
  assert.equal(commandProblem('gh issue create --repo o/r --title "two  spaces"'), null, 'two spaces in a row are fine');
});

test('r3: a command that isn’t one of the shapes is refused, with the reason', () => {
  for (const [text, reason] of [
    ['git -C /home/me/postbox push origin x', /lone git push/],
    ['gh pr edit 896 --add-label x', /--repo owner\/name/],
    ['echo hi', /isn’t a git push or one of the gh commands/],
  ])
    assert.match(errorsOf([text]).join('\n'), reason, text);
});

// Each class of refusal, with a character (or text) that only it catches, and the words its reason must use.
const REFUSED = [
  ['a run of three spaces', `git push${' '.repeat(3)}--force`, /three or more spaces in a row/],
  ['a 401-character command', `gh issue create --repo o/r --title ${'y'.repeat(370)}`, /longer than 400 characters/],
  ['a tab', 'git push\torigin', /U\+0009, a control character, a tab or a line break/],
  ['a line break', 'git push\ngit push', /U\+000A, a control character, a tab or a line break/],
  ['U+00A0, a no-break space', 'git push\u00A0origin', /U\+00A0, a space other than a plain one/],
  ['U+E000, a private-use character', 'git push\uE000', /U\+E000, an enclosing mark, a private-use or an unassigned character/],
  ['U+0007, a control character', 'git push\u0007', /U\+0007, a control character, a tab or a line break/],
  ['U+061C, an invisible format character', 'git push\u061C origin', /U\+061C, an invisible formatting character/],
  ['U+00AD, a soft hyphen', 'git pu\u00ADsh', /U\+00AD, an invisible formatting character/],
  ['U+2060, a word joiner', 'git\u2060push', /U\+2060, an invisible formatting character/],
  ['U+202E, a right-to-left override', 'git push \u202Eorigin', /U\+202E, an invisible formatting character/],
  ['U+FE0F, a variation selector', 'git push\uFE0F', /U\+FE0F, a variation selector/],
  ['U+E0041, a tag character', 'git push\u{E0041}', /U\+E0041, a tag character/],
  ['U+2028, a line separator', 'git push\u2028rm -rf ~', /U\+2028, a line or paragraph separator/],
  ['U+0301, a combining mark', 'git push origin\u0301', /U\+0301, a combining mark/],
  ['U+3164, a Hangul filler', 'git push\u3164origin', /U\+3164, a Hangul filler/],
];

for (const [name, text, reason] of REFUSED)
  test(`a command with ${name} is refused, and the refusal names the entry and the reason`, () => {
    assert.match(commandProblem(text) ?? '', reason);
    const errors = errorsOf([PUSH, text]);
    assert.ok(
      errors.some((e) => e.startsWith('commands[1] ') && reason.test(e)),
      `no error names commands[1] and ${reason}: ${JSON.stringify(errors)}`,
    );
    assert.ok(!errors.some((e) => e.startsWith('commands[0]')), 'the plain entry isn’t blamed');
  });

test('a confirm with more than three commands is refused', () => {
  assert.ok(errorsOf([PUSH, PUSH, PUSH, PUSH]).some((e) => /^commands has more than 3 items/.test(e)));
});

test('an empty command, an empty list and a command over 2,000 characters are refused', () => {
  assert.ok(errorsOf([PUSH, '']).some((e) => /^commands\[1\] can’t be empty/.test(e)));
  assert.ok(errorsOf([]).some((e) => /^commands needs at least one item/.test(e)));
  const long = Array.from({ length: 6 }, () => 'z'.repeat(399)).join('\n');
  assert.ok(errorsOf([long]).some((e) => /^commands\[0\] is longer than 2,000 characters/.test(e)));
  assert.ok(errorsOf(['git push', 7]).some((e) => /^commands\[1\] must be text/.test(e)));
});

test('show_block refuses a confirm whose command hides a character, so the person sees only its fallback', () => {
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'mock', folderFor: async () => null, deliver: async () => {} }),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'pusher' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  const r = tools.show_block({ block: confirm(['git push origin \u202Ewip/852']) });
  assert.equal(r.ok, false);
  assert.match(r.message, /commands\[0\] has U\+202E, an invisible formatting character/);
  const shown = store.items(t.id).filter((i) => i.kind === 'block');
  assert.deepEqual(
    shown.map((i) => ({ valid: i.valid, block: i.block, fallback: i.fallback })),
    [{ valid: false, block: undefined, fallback: 'Push the branch?' }],
    'no confirm the person can answer, only its fallback',
  );
});
