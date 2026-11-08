// #995’s side-by-side judge (tools/uat/side-by-side.mjs): a run’s first picture, as the reply left it, with the
// sentence it was meant to say, and a judge shown two of them, picture against picture.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pairShot } from '../tools/uat/pair-shot.mjs';
import { firstExchange } from '../tools/uat/picture-choice.mjs';
import { replyShot } from '../tools/uat/picture-shots.mjs';
import { firstPicture, firstPictureSection, firstSentence, judgePair, meantLabel, meantOf, PAIR_SCHEMA } from '../tools/uat/side-by-side.mjs';

const add = (id, kind, at, extra = {}) => ({ type: 'item.add', data: { threadId: 'th_1', item: { id, kind, at, ...extra } } });

/** A run folder: its Postbox log, its seeded agents, and screenshots taken at these times (ms). */
function runWith(events, shots = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-pair-'));
  for (const d of ['data', 'shots', 'workspace']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'data', 'events-1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const persona = { handle: 'researcher', description: 'Explains data.', instructions: 'Cite sources.' };
  writeFileSync(join(dir, 'data', 'agents.json'), JSON.stringify([persona]));
  for (const [name, at] of Object.entries(shots)) {
    writeFileSync(join(dir, 'shots', name), 'png');
    utimesSync(join(dir, 'shots', name), at / 1000, at / 1000);
  }
  return dir;
}

// An app in the first reply, a click on the agent’s own card, the app’s fixed version, then the next message.
const drew = [
  add('it_1', 'user', 1_000, { text: 'Which should I cancel?' }),
  add('it_2', 'agent', 2_000, { text: 'Drawing it.' }),
  add('it_3', 'block', 3_000, { block: { id: 'subs', type: 'app' } }),
  add('it_4', 'voice', 4_000, { text: 'Chose: That’s enough' }),
  add('it_5', 'agent', 5_000, { text: 'Cancel the gym.' }),
  add('it_6', 'user', 9_000, { text: 'And for a year?' }),
  add('it_7', 'agent', 9_500, { text: 'About $2,000.' }),
];

test('#995 the first exchange is the reply up to the person’s next message, clicks on the agent’s cards included', (t) => {
  const dir = runWith(drew);
  t.after(() => rmSync(dir, { recursive: true }));
  const x = firstExchange(join(dir, 'data'));
  assert.equal(x?.question, 'Which should I cancel?');
  assert.deepEqual(x?.visual, { kind: 'app', itemId: 'it_3', inputsBefore: 0 });
  assert.equal(x?.reply, 'Drawing it.\n\nCancel the gym.');
  assert.equal(x?.nextMessageAt, 9_000);
});

test('#995 the picture is shot as the reply left it, not while its check was at work', (t) => {
  const dir = runWith(drew, { '01-I3.png': 3_500, '03-I3.png': 8_000, '05-I3.png': 9_800 });
  t.after(() => rmSync(dir, { recursive: true }));
  assert.equal(replyShot(join(dir, 'shots'), 'I3', 9_000)?.n, 3);
  assert.equal(replyShot(join(dir, 'shots'), 'I3', null)?.n, 5, 'with no next message, the last shot');
  assert.equal(replyShot(join(dir, 'shots'), 'I9', null), null);
});

const pictures = [
  ...drew.slice(0, 3),
  { type: 'app', data: { id: 'subs', itemId: 'it_3', versions: [{ v: 1, at: 3_000, intent: 'Six cost over $10 a use.' }], check: { status: 'passed' } } },
  ...drew.slice(3),
];

test('#995 a run’s first picture is its question, its shot as the reply left it, and the sentence it was meant to say', async (t) => {
  const dir = runWith(pictures, { '01-I3.png': 3_500, '03-I3.png': 8_000 });
  t.after(() => rmSync(dir, { recursive: true }));
  const o = { dir, data: join(dir, 'data'), shots: join(dir, 'shots'), labels: new Map([['it_3', 'I3']]) };
  assert.deepEqual(await firstPicture(o), {
    question: 'Which should I cancel?',
    kind: 'app',
    item: 'I3',
    shot: 'shots/03-I3.png',
    inputsBefore: 0,
    intent: 'Six cost over $10 a use.',
    intentFrom: 'agent',
    v: 1,
  });
  const words = runWith([add('it_1', 'user', 1, { text: 'How many?' }), add('it_2', 'agent', 2, { text: '18.' })]);
  t.after(() => rmSync(words, { recursive: true }));
  assert.deepEqual(await firstPicture({ ...o, dir: words, data: join(words, 'data') }), { skipped: 'the agent answered in words' });
  assert.deepEqual(firstPictureSection({ skipped: 'the agent answered in words' }), [
    '## First picture',
    '',
    'None to compare: the agent answered in words.',
    '',
  ]);
  assert.deepEqual(firstPictureSection(undefined), []);
});

test('#995 a version from before intents gets the first sentence of its text version, marked as not the agent’s intent', () => {
  const app = { id: 'subs', versions: [{ v: 1, at: 1 }], check: 'passed', fallback: 'At $10+ per use, cancel six. Saves $171 a month.' };
  assert.deepEqual(meantOf(app, 5), { intent: 'At $10+ per use, cancel six.', intentFrom: 'fallback', v: 1 });
  assert.deepEqual(meantOf(null, 5), { intent: '', intentFrom: null, v: null });
  assert.equal(meantLabel({ intentFrom: 'fallback' }), 'The agent’s text version of it (it gave no intent)');
  assert.equal(meantLabel({ intentFrom: 'agent' }), 'What the agent meant it to say');
  assert.equal(firstSentence('No stop here'), 'No stop here');
  const long = 'Cost per use, monthly cost divided by uses per month, from your last 90 days, for each of your subscriptions. More.';
  assert.equal(firstSentence(long), 'Cost per use, monthly cost divided by uses per month, from your last 90 days, for…');
});

test('#995 the judge sees only the two pictures and what each was meant to say, as the maintainer does', async () => {
  const calls = [];
  const ask = async (args) => {
    calls.push(args);
    return { value: { pick: 'B', why: 'B shows which ones cost the most per use.' }, cost: 0.05 };
  };
  const sides = [
    { file: '1-a.png', intent: 'Six cost over $10 a use.', intentFrom: 'agent' },
    { file: '1-b.png', intent: 'Cancel the gym.', intentFrom: 'fallback' },
  ];
  const r = await judgePair({ persona: 'Someone.', question: 'Which should I cancel?', sides, cwd: '/out', model: 'm', ask });
  assert.deepEqual(r, { pick: 'B', why: 'B shows which ones cost the most per use.', cost: 0.05 });
  assert.equal(calls[0].cwd, '/out');
  assert.equal(calls[0].schema, PAIR_SCHEMA);
  const p = calls[0].prompt;
  assert.match(p, /## Picture A\n\nThe screenshot: 1-a\.png \(open it with Read\)\.\nWhat the agent meant it to say: “Six cost over \$10 a use\.”/);
  assert.match(p, /## Picture B\n\nThe screenshot: 1-b\.png \(open it with Read\)\.\nThe agent’s text version of it \(it gave no intent\): “Cancel the gym\.”/);
  assert.match(p, /Don’t prefer one for being busier, longer or more polished\./);
  assert.equal(p.includes('Drawing it.'), false, 'none of the reply’s words');
});

// The app’s v1 failed its check at 3_500 and was shown fixing; v2, fixed, came at 6_000 and passed.
const fixed = [
  ...drew.slice(0, 3),
  { type: 'app', data: { id: 'subs', itemId: 'it_3', versions: [{ v: 1, at: 3_000 }], check: { status: 'fixing' } } },
  {
    type: 'app',
    data: {
      id: 'subs',
      itemId: 'it_3',
      versions: [
        { v: 1, at: 3_000 },
        { v: 2, at: 6_000 },
      ],
      check: { status: 'passed' },
    },
  },
  ...drew.slice(3),
];

test('#995 a shot of the app at work on its check is retaken at the end of the run, or the run has no pair', async (t) => {
  const dir = runWith(fixed, { '01-I3.png': 3_500 });
  t.after(() => rmSync(dir, { recursive: true }));
  const visual = { kind: 'app', itemId: 'it_3' };
  const base = { data: join(dir, 'data'), shots: join(dir, 'shots'), label: 'I3', visual, nextMessageAt: 9_000 };
  assert.deepEqual(await pairShot(base), { skipped: 'no screenshot of the app’s finished version (v2)' });
  const shot = [];
  const shoot = async (label, file) => {
    shot.push(label);
    return file;
  };
  const r = await pairShot({ ...base, shoot });
  assert.deepEqual(shot, ['I3']);
  assert.equal('shot' in r && r.shot.file, join(dir, 'shots', 'judge-I3.png'));
  assert.equal('retaken' in r && r.retaken, true);
  // A shot taken after the last version is the picture as the reply left it.
  const later = runWith(fixed, { '03-I3.png': 7_000 });
  t.after(() => rmSync(later, { recursive: true }));
  const kept = await pairShot({ ...base, shots: join(later, 'shots'), data: join(later, 'data'), shoot });
  assert.equal('shot' in kept && kept.shot.file, join(later, 'shots', '03-I3.png'));
  assert.equal(shot.length, 1, 'nothing retaken');
});
