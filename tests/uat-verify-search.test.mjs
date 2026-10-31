// #483: the verifier can search a run’s records. In the hostwakes run of 27 October 2026 it marked “Refusal notice
// doesn’t name the card” as not reproduced, “only agents’ paraphrases”, though Postbox’s notice was on 206 lines of the
// run’s data/events-1.jsonl; and it judged a held step as if it had run. It had only Read, and no word of where the
// records are or what they hold.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { askOnce, verifyPrompt } from '../tools/uat/tester.mjs';

const prompt = verifyPrompt({
  scenario: { title: 'Host wakes' },
  findings: [
    {
      title: 'Refusal notice doesn’t name the card',
      category: 'ux',
      severity: 'medium',
      component: 'refusal notice',
      step: 11,
      evidence: 'agents’ paraphrases',
    },
  ],
  timeline: [],
  issues: [],
});

test('#483 the verifier is told where a run’s records are, and to search them before it calls a finding not reproduced', () => {
  // The records moved from data/events-*.jsonl to the run folder’s events.jsonl and state.json with the store on Redis (#508).
  assert.match(prompt, /events\.jsonl/);
  assert.match(prompt, /state\.json/);
  assert.match(prompt, /streams\//);
  assert.match(prompt, /run\.log/);
  assert.match(prompt, /search them with Grep/);
  assert.match(prompt, /action held/, 'a step the runner held didn’t happen as the tester asked');
});

test('#483 the verifier gets Grep beside Read, so it can search the records it’s told about', async () => {
  /** @type {string[]} */
  let args = [];
  const run = (_bin, a) => {
    args = a;
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { end: () => {} } });
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ structured_output: { results: [] }, total_cost_usd: 0 }));
      child.emit('close', 0);
    });
    return child;
  };
  await askOnce({ cwd: '.', model: 'm', prompt: 'p', schema: {}, run });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep');
});

test('#483 the verifier is told a queued wake isn’t a refusal, and an open issue’s behavior isn’t by-design', () => {
  // The recheck of that run, with search, still called a queued wake “reported as success” after a mention’s refusal,
  // and called the dropped hand-offs by-design though #439 proposes holding them.
  assert.match(prompt, /it’s busy, so it answers when its current turn ends” queued it/);
  assert.match(prompt, /Your mention of @x woke no one: …” in a session’s context is about an @-mention/);
  assert.match(prompt, /An open issue that proposes changing a behavior means the behavior isn’t by-design/);
  assert.match(prompt, /Judge the claim a finding makes, not the defect nearby/);
});
