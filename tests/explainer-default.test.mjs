// What an explainer is by default: one picture with a control that changes it, and practice only when the person asks.
// UAT runs on 6 November 2026 showed the old wording (“explainers with exercises”, “then a small practice app”)
// turning a request for a visual explanation into an unrequested quiz.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { guideText } from '../server/adapters/guide.mjs';
import { asksToPractice } from '../server/adapters/mock-explainer.mjs';
import { DEMO_PERSONAS } from '../server/seed.mjs';

const uatPersonas = JSON.parse(readFileSync(new URL('./uat/e2e/personas.json', import.meta.url), 'utf8'));
const researcher = (list) => list.find((p) => p.handle === 'researcher');

test('the guide’s explainer recipe is one picture with a control, with practice only on request', () => {
  const lines = guideText().split('\n');
  assert.equal(
    lines.find((line) => line.startsWith('- Explainer')),
    '- Explainer: one picture that carries the idea, with one control that changes it. A predict-first question never hides the picture; practice only when asked.',
  );
  const examples = lines.find((line) => line.startsWith('When a tool explains better than prose'))?.match(/\(([^)]*)\)/)?.[1];
  assert.equal(examples, 'an explorer, a simulator');
});

// The maintainer’s blind verdicts on 20 agent-made visuals (#206, 6 November 2026) failed every diagram of labeled boxes,
// a well-made Mermaid flowchart included, and the guide was telling agents to draw diagrams as chains of boxes.
test('the guide says a picture that explains draws the things, not labeled boxes, and no recipe asks for a Mermaid diagram', () => {
  const g = guideText();
  assert.doesNotMatch(g, /boxes side by side|flowchart TD|anything over about 15 boxes/);
  assert.match(g, /A picture that explains draws what things are or do, not labeled boxes/);
  const recipes = readFileSync(new URL('../designs/recipes.md', import.meta.url), 'utf8');
  const explainer = recipes.split('\n').find((line) => line.startsWith('| Explainer'));
  assert.ok(explainer && !/Mermaid/.test(explainer), explainer);
});

// Agents drew almost exactly when they loaded the visual-explainer skill, so the choice was made before the skill ran
// (#983). The guide reaches every agent on every backend, so it decides whether to draw, and the skill keeps how (#996).
test('the guide decides when to draw: name the shape, words for what has none, answer then picture, ask only when ambiguous', () => {
  const rule = guideText()
    .split('\n')
    .find((line) => line.startsWith('- A question to answer'));
  assert.ok(rule, 'The guide has no rule for when to draw.');
  assert.match(rule, /name the answer’s shape in a word/);
  assert.match(rule, /One fact, a command, a basic how-to or a step-by-step calculation gets words/);
  assert.match(rule, /Any other shape .* gets a picture in an app, asked for or not/);
  assert.match(rule, /the answer in a sentence or two, then the picture in the same turn/);
  assert.match(rule, /Ask first only when the question has more than one reasonable reading/);
});

test('the demo and UAT researcher explain with a picture when they explain visually, and add practice only on request', () => {
  for (const p of [researcher(DEMO_PERSONAS), researcher(uatPersonas)]) {
    assert.equal(p.description, 'Reads papers and explains them with a picture you can change.');
    assert.equal(
      p.instructions,
      'Cite sources. When you explain visually, use one picture that carries the idea and one control that visibly changes it; a predict-first question is fine if the picture shows first. Add practice or a quiz only when the person asks for it.',
    );
  }
});

test('the mock researcher shows its practice app only when the person asks for something to try', () => {
  assert.equal(asksToPractice('Explain ReAct'), false);
  assert.equal(asksToPractice('Explain how ReAct reasons, visually'), false);
  assert.equal(asksToPractice('Explain ReAct with something I can try'), true);
  assert.equal(asksToPractice('Give me a quiz on ReAct'), true);
});
