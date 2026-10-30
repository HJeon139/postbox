// #296: what a request may ever let through without a card is an allow-list in code. Each call here was found by the
// review of #557 to reach the judge under the blocklist that came before; each must now get the card.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offRequest, shellWords } from '../server/request-floor.mjs';

const scope = {
  named: 'open the pr for #508 on hjeon139/postbox, and push it to origin.',
  made: { urls: ['https://github.com/HJeon139/postbox/pull/537'], numbers: ['537'] },
};
const bash = (command) => offRequest('Bash', { command }, scope);
const BODY = `"$(cat <<'EOF'\n## Why\n\nCloses #508. Removes the old flag.\nEOF\n)"`;

test('a command is read as the shell would, and one it can’t read is nothing', () => {
  assert.deepEqual(shellWords(`gh pr create --title "a \\"b\\"" -b 'c d'`), ['gh', 'pr', 'create', '--title', 'a "b"', '-b', 'c d']);
  assert.deepEqual(shellWords('gh pr create --title "unclosed'), []);
  assert.ok(bash('gh pr create --title "unclosed'));
});

test('plain pushes, gh creates, comments and edits within #296’s limits, and reads can be covered', () => {
  for (const command of [
    'git push',
    'git push -u origin feat/now',
    'git add -A && git commit -m "delete dead code" && git push origin main',
    `gh pr create --title "Close the gap" --body ${BODY}`,
    'gh pr create --repo HJeon139/postbox --title x --body y --draft',
    'gh issue comment 508 --body "Pushed."',
    'gh pr comment 537 --body "CI is green."',
    'gh pr edit https://github.com/HJeon139/postbox/pull/537 --body "Now, with tests."',
    'git status && git log --oneline -3 | head -3',
  ])
    assert.equal(bash(command), null, command);
});

test('#557’s review: every force, delete and rewrite of git asks', () => {
  for (const command of [
    'git push origin +main',
    'git push origin :feature',
    'git push -d origin feature',
    'git push --mirror',
    'git push origin HEAD:main',
    'git push -f',
    'git -c alias.p=push p -f',
    'git -C ../other push',
    'git p -f',
    'git tag -d v1',
    'git branch -d old',
    'git update-ref -d refs/heads/x',
    'git checkout -- .',
    'git restore .',
    'git reset --hard HEAD~1',
    'git fetch --prune',
  ])
    assert.ok(bash(command), command);
});

test('#557’s review: gh writes past #296’s limits ask: another repository, an item nobody named, labels, locks, settings, secrets, the API', () => {
  for (const command of [
    'gh pr create --repo other/repo --title x --body y',
    'gh issue edit 3 --remove-label bug',
    'gh issue comment 3 --body x',
    'gh issue comment https://github.com/someone/else/issues/508 --body x',
    'gh issue lock 508',
    'gh repo edit --visibility public',
    'gh secret set TOKEN',
    'gh api -X PATCH repos/o/r -f archived=true',
    'gh api -XDELETE repos/o/r',
    'gh api graphql -f query="mutation { deleteRepository }"',
    'gh pr m 537',
    'gh pr merge 537',
    'gh pr comment 537 --delete-last',
    'gh pr create --title x --reviewer someone',
  ])
    assert.ok(bash(command), command);
});

test('#557’s review: a shell or an interpreter, a destructive command, a redirect and a VAR=value ask, anywhere in a chain', () => {
  for (const command of [
    'tally ticket --id 1 delete',
    'sh -c "rm -r src"',
    'printf "rm -rf src" | sh',
    'python3 -c "import shutil; shutil.rmtree(\'src\')"',
    "node -e \"require('fs').rmSync('src', { recursive: true })\"",
    'find . -delete',
    'crontab -r',
    ': > db',
    'cp /dev/null db',
    'mv a b',
    'echo hi >> README.md',
    'gh issue comment 508 -b x && sh -c "rm -rf ~"',
    `gh pr create --title x --body "$(rm -rf ~)"`,
    'GIT_SSH_COMMAND="rm -rf ~" git push',
  ])
    assert.ok(bash(command), command);
});

test('an MCP tool passes only by a verb that creates or edits, never one that also takes away, and only with its input', () => {
  for (const tool of ['mcp__tally__create_ticket', 'mcp__tally__add_ticket_comment', 'mcp__docs__create_document', 'mcp__linear__createIssue'])
    assert.equal(offRequest(tool, { title: 'x' }, scope), null, tool);
  for (const tool of ['mcp__gh__deleterepo', 'mcp__github__merge_pull_request', 'mcp__linear__archiveIssue', 'mcp__tally__delete_ticket', 'mcp__x__get_thing'])
    assert.ok(offRequest(tool, { title: 'x' }, scope), tool);
  assert.ok(offRequest('mcp__tally__create_ticket', undefined, scope), 'Codex asks without the arguments');
  assert.ok(offRequest('mcp__tally__create_ticket', {}, scope));
  assert.ok(offRequest('Write', { file_path: '/x' }, scope), 'only commands and MCP tools');
});
