import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLint, lintMessage, termProblems } from '../server/checks.mjs';

const app = (code, message) => ({ code, message, scope: { kind: 'app', id: 'pairs', title: 'Pair explorer' } });

test('a lint message drops repeated problems, and groups the rest by what they’re about', () => {
  const m = lintMessage([...termProblems('Step 2, then Step 2 again.', {}), app('marks-too-small', 'Tiny.'), app('marks-too-small', 'Tiny.')]);
  assert.equal(m.problems.length, 2);
  const text = formatLint(m);
  assert.match(text, /^\[Postbox\] Your reply used terms you haven’t defined\. Define each with define_term:\n- Step 2/);
  assert.match(text, /Your app “Pair explorer” \(id pairs\) is shown, with these warnings:\n- Tiny\./);
  assert.match(text, /Fix each app with update_app\./);
});

test('a lint turn that only needs tool calls tells the agent no reply is needed', () => {
  assert.match(formatLint(lintMessage(termProblems('Phase 3', {}))), /No reply is needed/);
  const diagram = { code: 'text-too-small', message: 'Small.', scope: { kind: 'diagram', index: 0, excerpt: 'flowchart LR\nA-->B' } };
  const text = formatLint(lintMessage([diagram]));
  assert.match(text, /Diagram 1 in your reply can’t be read \(it starts “flowchart LR”\):\n- Small\./);
  assert.doesNotMatch(text, /No reply is needed/);
});
