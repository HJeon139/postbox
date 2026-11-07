// #852 slice 1a r3: the command shapes a confirm may hold (shared/confirm-shapes.mjs), each refused when one word is
// off, with lead-security’s option-injection cases (r3 v2, P1 1).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmShape, shapeWords } from '../shared/confirm-shapes.mjs';

const R = '--repo o/r';

test('#852 r3: each shape is read, with its argv and repository', () => {
  assert.deepEqual(confirmShape('git push'), { kind: 'push' });
  assert.deepEqual(confirmShape('git push origin feat/now'), { kind: 'push' });
  assert.deepEqual(confirmShape('git push -u origin feat/now'), { kind: 'push' });
  const create = confirmShape(`gh pr create ${R} --head feat/now --title "fix(x): a thing" --body-file /tmp/pb-x/b.md --draft --label P2`);
  assert.deepEqual(create, {
    kind: 'gh',
    argv: ['pr', 'create', '--repo', 'o/r', '--head', 'feat/now', '--title', 'fix(x): a thing', '--body-file', '/tmp/pb-x/b.md', '--draft', '--label', 'P2'],
    repo: 'o/r',
    bodyFile: '/tmp/pb-x/b.md',
  });
  for (const ok of [
    `gh pr edit 896 ${R} --add-label "ready for integrator" --remove-label "changes requested"`,
    `gh pr comment 896 ${R} --body-file /tmp/pb-x/b.md`,
    `gh issue create ${R} --title T --label bug --label P2`,
    `gh issue edit 12 ${R} --add-label P1`,
    `gh issue comment 12 ${R} --body-file /tmp/pb-x/b.md`,
  ])
    assert.equal(confirmShape(ok).kind, 'gh', ok);
});

test('#852 r3: anything else is refused, with a reason', () => {
  for (const bad of [
    'git status',
    'git push other feat/now',
    'git push --force origin feat/now',
    'git push origin feat/now extra',
    'git push origin ../x',
    'cd /tmp && gh pr edit 1 --repo o/r --add-label x',
    'gh pr merge 1 --repo o/r',
    'gh repo delete o/r',
    'gh pr edit 896 --add-label x',
    `gh pr edit 896 ${R} --repo o/s --add-label x`,
    'gh pr edit 896 -R o/r --add-label x',
    'gh pr edit 896 --repo=o/r --add-label x',
    `gh pr edit ${R} --add-label x`,
    `gh pr edit 896 ${R} --title --web`,
    `gh pr edit 896 ${R} --add-label -R`,
    `gh pr edit 896 ${R} --web`,
    `gh pr edit 896 ${R} --body "Hello"`,
    `gh pr edit 896 ${R} --body-file b.md`,
    `gh pr edit 896 ${R} --title A --title B`,
    `gh pr create ${R} --title T`,
    `gh pr create ${R} --head owner:feat`,
    `gh pr create ${R} --head ../x`,
    `gh pr comment 896 ${R}`,
    `gh pr edit 896 ${R} --add-label $(id)`,
    `gh pr edit 896 ${R} --add-label x; curl y`,
    `gh pr edit 896 ${R} --add-label x | sh`,
    `gh pr edit 896 ${R} --add-label "a"b`,
    `gh pr edit 896 ${R}\t--add-label x`,
    `gh pr edit 896 ${R}\n--add-label x`,
    `gh pr edit 896 ${R} --add-label 'x`,
    '',
  ]) {
    const r = confirmShape(bad);
    assert.equal(r.kind, 'none', JSON.stringify(bad));
    assert.ok('why' in r && r.why.length > 10, JSON.stringify(bad));
  }
});

test('#852 r3: the word reader takes quotes as one word and expands nothing', () => {
  assert.deepEqual(shapeWords(`a "b c" 'd e' f`), ['a', 'b c', 'd e', 'f']);
  for (const bad of ['a $b', 'a `b`', 'a \\b', 'a (b)', 'a {b}', 'a > b', 'a < b', 'a ~b', 'a *b', 'a\tb', 'a\nb', 'a"b"c'])
    assert.equal(shapeWords(bad), null, bad);
  assert.deepEqual(shapeWords(`t "fix(x): it’s $HOME"`), ['t', 'fix(x): it’s $HOME'], 'inside quotes, taken exactly');
});
