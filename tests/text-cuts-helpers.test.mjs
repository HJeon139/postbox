// #1686, part 2: the private clip helpers and the step text cuts end, and a kept tail starts, only at a whole
// character, never between the two halves of a surrogate pair, which the reader sees as two replacement characters.
// Each case puts an emoji across its site’s cut.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { clip as agyClip } from '../server/adapters/agy-refusals.mjs';
import { describePermission } from '../server/adapters/claude-permission.mjs';
import { listClaudeSessions } from '../server/adapters/terminal-mirror.mjs';
import { HarnessText } from '../server/harness-text.mjs';
import { clip as harnessClip } from '../server/harness-tools.mjs';
import { clip as gitClip } from '../server/ledger-git.mjs';
import { stepDiff } from '../server/step-diff.mjs';
import { stepInput, stepOutput, turnStep } from '../server/step-text.mjs';
import { describeTool } from '../server/tool-labels.mjs';
import { STEP_TEXT } from '../shared/limits.mjs';
import { clip as protocolClip } from '../shared/remote-protocol-checks.mjs';
import { foldedStep } from '../shared/step-fold.mjs';
import { glimpseOf } from '../shared/text.mjs';
import { tailText } from '../shared/text-parts.mjs';
import { tempDir } from './temp-dirs.mjs';

const EMOJI = '😀';
/** Text whose emoji starts at the last character a cut to n keeps, so a raw slice keeps half of it. */
const across = (n, pad = 'x') => pad.repeat(n - 1) + EMOJI + 'tail';
/** Text whose emoji ends at the first character a tail of n keeps, so a raw slice starts on its second half. */
const acrossTail = (n, pad = 'x') => 'head' + EMOJI + pad.repeat(n - 1);
const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(s));
function whole(s, where) {
  assert.ok(typeof s === 'string' && s.length > 0, `${where} wasn’t found`);
  assert.equal(lone(s), false, `${where} ends inside a character`);
}

test('#1686 the clip helpers that cut to n - 1 and add … keep the emoji at the cut whole', () => {
  // Each cuts to n - 1 characters, so the emoji starts at n - 2.
  whole(harnessClip(across(79), 80), 'harness-tools clip');
  whole(gitClip(across(199), 200), 'ledger-git clip');
  whole(agyClip(across(79), 80), 'agy-refusals clip');
  whole(protocolClip(across(59), 60), 'remote-protocol-checks clip');
  whole(describeTool('Bash', { description: across(79), command: 'ls' }), 'a tool label');
  whole(describePermission('Bash', { description: across(79), command: 'ls' }).summary, 'a permission summary');
});

test('#1686 a permission card’s detail and its path lines keep both ends whole', () => {
  // A path cut in its middle keeps its start and its end, the file’s name: 999 characters each, for one path line of
  // 1,999 (pathLines); the first path’s emoji is at its head’s cut, the second’s at its tail’s. An MCP call’s detail is
  // its JSON, whose text starts 13 characters in.
  const detail = describePermission('Read', { paths: [`/a/${'d'.repeat(995)}${EMOJI}${'e'.repeat(1200)}`, `/b/${'h'.repeat(1500)}${acrossTail(999)}`] }).detail;
  whole(detail, 'the path lines');
  whole(describePermission('mcp__x__y', { text: across(4000 - 13) }).detail, 'an MCP call’s detail');
});

test('#1686 a step’s label, who, detail, diff, input and folded detail are cut whole', () => {
  const s = turnStep({ id: 's', label: across(200), who: across(40), detail: across(STEP_TEXT.detail), diff: across(STEP_TEXT.output), state: 'done' });
  for (const k of ['label', 'who', 'detail', 'diff']) whole(s[k], `a step’s ${k}`);
  whole(turnStep({ id: 't', label: 'x', kind: 'thought', detail: across(STEP_TEXT.thought), state: 'done' }).detail, 'a thought’s detail');
  whole(stepInput(across(STEP_TEXT.input - 1)), 'a step’s input');
  // A path over STEP_TEXT.input (300) keeps its first 89 characters and its last 210, the file name.
  const tail = Math.ceil((STEP_TEXT.input - 1) * 0.7);
  whole(stepInput(`/a/b/${'p'.repeat(200)}${acrossTail(tail)}`), 'a path input’s tail');
  whole(stepInput(`/a/b/${across(STEP_TEXT.input - 1 - tail - 5)}${'q'.repeat(400)}`), 'a path input’s head');
  whole(foldedStep({ id: 'f', detail: across(STEP_TEXT.detail) }).detail, 'a folded step’s detail');
});

test('#1686 a diff’s long line, a thought step’s detail and a glimpse are cut whole', () => {
  const diff = stepDiff('Write', { file_path: 'a.txt', content: across(119) }, null);
  whole(diff?.diff, 'a diff line');
  const steps = [];
  const text = new HarnessText(
    { activity: (a) => steps.push(a) },
    () => {},
    () => 0,
  );
  text.thoughtStep(across(STEP_TEXT.thought));
  whole(steps[0]?.detail, 'a thought step’s detail');
  text.narrate(across(STEP_TEXT.thought));
  whole(steps[1]?.detail, 'a subagent’s said step’s detail');
  whole(glimpseOf(`${across(39)}.`, 40), 'a glimpse');
  assert.equal(glimpseOf('ab.', 1), '…', 'a glimpse stays within its bound');
  // The end of what a call returned, on one line: the tail’s first character would be the emoji’s second half.
  whole(stepOutput(acrossTail(STEP_TEXT.output - 1)), 'a step’s output');
});

test('#1686 a Claude Code session’s title in the picker is cut whole', async () => {
  const root = tempDir('pb-cut-sessions-');
  mkdirSync(join(root, 'proj'));
  const line = { type: 'user', cwd: '/w', message: { role: 'user', content: across(79) } };
  writeFileSync(join(root, 'proj', '0123abcd-0123-4abc-8abc-0123456789ab.jsonl'), `${JSON.stringify(line)}\n`);
  const [found] = await listClaudeSessions({ root });
  whole(found?.title, 'a session’s title');
});

test('#1686 tailText never starts inside a pair, and is the whole text when it fits', () => {
  assert.equal(tailText(`a${EMOJI}bc`, 3), 'bc');
  assert.equal(tailText(`a${EMOJI}bc`, 4), `${EMOJI}bc`);
  assert.equal(tailText('abc', 5), 'abc');
});
