// What an explainer is by default: one picture with a control that changes it, and practice only when the person asks.
// UAT runs on 6 November 2026 showed the old wording (“explainers with exercises”, “then a small practice app”)
// turning a request for a visual explanation into an unrequested quiz.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { guideText } from '../server/adapters/guide.mjs';
import { DEMO_PERSONAS } from '../server/seed.mjs';

const uatPersonas = JSON.parse(readFileSync(new URL('./uat/e2e/personas.json', import.meta.url), 'utf8'));
const researcher = (list) => list.find((p) => p.handle === 'researcher');

test('the guide’s explainer recipe is one visual with a control, with a practice app only on request', () => {
  const recipe = guideText()
    .split('\n')
    .find((line) => line.startsWith('- Explainer'));
  assert.match(recipe, /one visual that carries the idea, with one control that changes it/);
  assert.match(recipe, /predict-first question is fine/);
  assert.match(recipe, /practice app only when asked/);
  assert.doesNotMatch(guideText(), /exercise\)|then a small practice app/);
});

test('the demo and UAT researcher explain with a picture, ask for no exercise, and say the same thing', () => {
  const demo = researcher(DEMO_PERSONAS);
  const uat = researcher(uatPersonas);
  for (const p of [demo, uat]) {
    assert.doesNotMatch(`${p.description} ${p.instructions}`, /exercise/i);
    assert.match(p.instructions, /one control that visibly changes it/);
    assert.match(p.instructions, /only when the person asks/);
  }
  assert.equal(uat.description, demo.description);
  assert.equal(uat.instructions, demo.instructions);
});
