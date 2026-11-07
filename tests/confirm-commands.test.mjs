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

const PUSH = 'git -C /home/me/postbox push origin wip/852-field';
const LONG = `cd /home/me/postbox && gh pr edit 896 --repo owner/postbox --add-label ready\ngh pr view 896 --repo owner/postbox\t--json state`;

test('a confirm with one to three plain commands passes, tabs and new lines included', () => {
  for (const commands of [[PUSH], [PUSH, LONG], [PUSH, LONG, 'x'.repeat(400)]]) {
    const r = validateBlock(confirm(commands));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  }
  assert.equal(commandProblem(LONG), null);
  assert.equal(commandProblem(`${'a'.repeat(400)}\n${'b'.repeat(400)}`), null, 'each line may be 400 characters');
  assert.equal(commandProblem('git commit -m "two  spaces"'), null, 'two spaces in a row are fine');
});

// Each class of refusal, with a character (or text) that only it catches, and the words its reason must use.
const REFUSED = [
  ['a run of three spaces', `git push${' '.repeat(3)}--force`, /three or more spaces in a row/],
  ['a 401-character line', `echo ${'y'.repeat(396)}`, /a line longer than 400 characters/],
  ['U+0007, a control character', 'git push\u0007', /U\+0007, a control character/],
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
