// #995: the agent’s intent against the customer’s takeaway (tools/uat/intent-match.mjs). The judge is given the intent
// only after the takeaway was written, and the report shows both sentences and whether they match.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appAt, intentCell, MATCH_SCHEMA, matchIntents, matchPrompt, versionAt } from '../tools/uat/intent-match.mjs';
import { judgePictures } from '../tools/uat/picture-judges.mjs';
import { visualSection } from '../tools/uat/visual-judge.mjs';

const said = 'Six subscriptions cost over $10 a use; cancel those.';
const versions = [
  { v: 1, at: 1_000, intent: said },
  { v: 2, at: 5_000, intent: '' },
];
const events = [
  { type: 'item.add', data: { threadId: 'th_1', item: { id: 'it_3', kind: 'block', at: 1_000, block: { id: 'subs', type: 'app' } } } },
  { type: 'app', data: { id: 'subs', itemId: 'it_3', versions: versions.slice(0, 1) } },
  { type: 'app', data: { id: 'subs', itemId: 'it_3', versions } },
];

function runWith(shots) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-intent-'));
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(dir, 'shots'));
  writeFileSync(join(dir, 'data', 'events-1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  for (const [name, at] of Object.entries(shots)) {
    writeFileSync(join(dir, 'shots', name), 'png');
    utimesSync(join(dir, 'shots', name), at / 1000, at / 1000);
  }
  return dir;
}

test('#995 an app’s versions are read from the log, and a screenshot shows the newest saved by then', (t) => {
  const dir = runWith({});
  t.after(() => rmSync(dir, { recursive: true }));
  assert.deepEqual(appAt(join(dir, 'data'), 'it_3'), { id: 'subs', versions, check: null, fallback: '' });
  assert.equal(appAt(join(dir, 'data'), 'it_9'), null, 'an item that isn’t an app');
  assert.equal(versionAt(versions, 4_000)?.v, 1);
  assert.equal(versionAt(versions, 6_000)?.v, 2);
  assert.equal(versionAt(versions, 10)?.v, 1, 'a shot older than the first version shows the first');
});

test('#995 the judge compares the takeaway with the intent of the version the tester saw, and nothing without one', async (t) => {
  const dir = runWith({ '01-I3.png': 2_000, '04-I3.png': 6_000 });
  t.after(() => rmSync(dir, { recursive: true }));
  const takeaway = 'The red dots, cheap per use or not, are the ones to cancel.';
  const timeline = [
    { step: 2, visual: { item: 'I3', takeaway } },
    { step: 5, visual: { item: 'I3', takeaway } },
    { step: 6, visual: { item: 'I7', takeaway } },
  ];
  const calls = [];
  const ask = async (args) => {
    calls.push({ ...args, files: readdirSync(args.cwd) });
    return { value: { match: 'partly', why: 'It names the six, not the $10 line.' }, cost: 0.01 };
  };
  const keys = new Map([
    ['I3', 'it_3'],
    ['I7', 'it_7'],
  ]);
  const spent = await matchIntents({ timeline, data: join(dir, 'data'), shots: join(dir, 'shots'), keys, ask, model: 'm', log: () => {} });
  assert.equal(calls.length, 1, 'only the version with an intent is compared');
  assert.equal(calls[0].prompt, matchPrompt(said, takeaway));
  assert.deepEqual(calls[0].files, [], 'an empty folder of its own: it needs only the two sentences');
  assert.equal(calls[0].schema, MATCH_SCHEMA);
  assert.equal(spent, 0.01);
  assert.deepEqual(timeline[0].visual, { item: 'I3', takeaway, intent: said, intentV: 1, match: 'partly', matchWhy: 'It names the six, not the $10 line.' });
  assert.equal(intentCell(timeline[1].visual), 'none: v2 had no intent');
  assert.equal(intentCell(timeline[2].visual), 'not an app');
  const wordy = 'This picture shows how the monthly cost of each subscription compares with how often you actually used it lately.';
  assert.equal(intentCell({ intent: wordy, intentV: 1 }), `${wordy} (19 words, over 16)`);
  const row = visualSection([
    { step: 2, visual: { ...timeline[0].visual, drawn: true, relationship: true, one_idea: true, readable: true, verdict: 'mostly' } },
  ]);
  assert.ok(row.includes(`| 2 | I3 | mostly | yes | yes | yes | yes | ${takeaway} | ${said} | partly |`));
});

test('#995 the judge is told to compare the point, with the intent given after the takeaway was written', () => {
  const p = matchPrompt('A', 'B');
  assert.match(p, /what the picture should leave the reader with:\n“A”/);
  assert.match(p, /not that sentence, said it tells them:\n“B”/);
  assert.match(p, /Judge the point, not the wording\./);
  assert.deepEqual(MATCH_SCHEMA.properties.match.enum, ['yes', 'partly', 'no']);
});

test('#995 a judge that throws on an unreadable run folder is logged, and the run goes on to its report', async (t) => {
  const dir = runWith({});
  t.after(() => rmSync(dir, { recursive: true }));
  // A shots “folder” that’s a file: reading it throws.
  writeFileSync(join(dir, 'not-a-folder'), 'x');
  const timeline = [{ step: 2, visual: { item: 'I3', takeaway: 'Six to cancel.' } }];
  const facts = {};
  const logged = [];
  const paths = { data: join(dir, 'data'), shots: join(dir, 'not-a-folder') };
  const keys = new Map([['I3', 'it_3']]);
  const o = { scenario: { judge: 'visual' }, dir, paths, labels: new Map([['it_3', 'I3']]), keys, timeline, facts, model: 'm' };
  await judgePictures({ ...o, ask: async () => ({ value: {}, cost: 0 }), log: (l) => logged.push(l) });
  assert.match(logged[0], /^The intent judge failed: /);
  assert.ok(facts.firstPicture.skipped, 'no first picture, and no throw');
  assert.deepEqual(facts.pictureJudges, { usd: 0 });
});
