// #1686, the reopened sweep: the line a call leaves when the person’s request covered it shows the whole call, cut to
// its bound only at a whole character (cutText). The case puts an emoji across that cut.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterBlock, bash, confirm, lines, setup } from './requested-setup.mjs';
import { across, whole } from './text-cuts-fixture.mjs';

test('#1686 a call a confirm showed, past the line’s bound, shows on its line cut whole', async () => {
  const s = await setup();
  // The judge reads no call past 8,000 characters, but a confirm matches its command with runs of spaces as one, so
  // a command padded with spaces runs without a card. The line keeps its first 8,000 (write-intent.mjs, MAX_CALL):
  // the emoji starts at the last.
  const head = 'gh pr create --title "feat(now): what each agent is doing now" --body "';
  const command = `${head}${' '.repeat(7999 - head.length - 9)}${across(10)}"`;
  const statement = `I’ll open the PR for Now:\n\n\`\`\`\n${command.replace(/\s+/g, ' ')}\n\`\`\``;
  assert.deepEqual(await afterBlock(s, confirm(statement), ['confirm', {}], [bash(command)]), [true]);
  whole(lines(s)[0]?.detail, 'the call’s detail');
});
