// What an agent reads, byte for byte (designs/architecture/services.md, “Memory”): the catch-up a turn starts with,
// a topic thread’s catch-up and header, a mention given before as a pointer (#484), read_conversation and
// read_message. One room holds an item of every kind an agent reads, the person’s message to an agent (“The person,
// to @alpha:”, #1334), a long mention (#499), a held wake (#693), a thread with a summary (#228) and a reaction
// (#251). Built through the facade and the fixture only, so a change to how Memory is put together can’t change it;
// ids, temp folders and clock times are replaced by names before comparing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const RECEIPT = 'Each entry was checked against its receipt. ';
const LONG = `The audit of the ledger, part by part. ${RECEIPT.repeat(60)}`;

/** A block of each type beta shows, with what the person answered or how it closed, as its line reads to alpha. */
const BLOCKS = [
  [{ type: 'card', title: 'Totals', body: 'Two differ.', facts: [{ label: 'Rows', value: '12' }], actions: [{ id: 'ok', label: 'Fine' }] }],
  [
    {
      type: 'choice',
      prompt: 'Which first?',
      options: [
        { id: 'a', label: 'March' },
        { id: 'b', label: 'April' },
      ],
    },
    { answered: true, answer: { values: { selected: ['b'] } } },
  ],
  [
    {
      type: 'form',
      prompt: 'Details',
      fields: [
        { id: 'n', label: 'Name', kind: 'text', required: true },
        { id: 'x', label: 'Sync', kind: 'toggle' },
      ],
    },
    { answered: true, answer: { values: { n: 'Ada', x: true } } },
  ],
  [{ type: 'code', filename: 'a.js', language: 'js', code: 'let a = 1;' }],
  [
    {
      type: 'review',
      title: 'Draft',
      content: 'The totals.',
      threads: [
        {
          line: 1,
          status: 'open',
          comments: [
            { author: 'you', text: 'Which?' },
            { author: '@beta', text: 'Row 4.' },
          ],
        },
      ],
    },
    { answered: true, answer: { voice: 'Submitted review: Changes asked', values: { comments: [{ line: 1, text: 'Recount.' }] } } },
  ],
  [{ type: 'confirm', statement: 'Ship it?' }, { closed: { handle: 'beta', reason: 'Not needed.' } }],
];

/** Beta shows each of BLOCKS; returns the card, which the person reacts to. */
function blocks(say, se) {
  const [card] = BLOCKS.map(([block, more]) => say({ kind: 'block', valid: true, sessionId: se.id, handle: 'beta', block, ...more }));
  return card;
}

/** A room with one item of each kind alpha reads, and a topic thread beta answered in. */
function room() {
  const f = setup();
  const { rt, t, alpha, beta } = f;
  const at = (n) => alpha.startedAt + n * 1000;
  const say = (item) => arrange.post(rt, t.id, { at: at(1), ...item });
  const asked = say({ kind: 'user', text: 'Which totals differ?', to: ['alpha', 'beta'], attachments: [{ kind: 'project-file', path: 'notes/a.md' }] });
  say({ kind: 'user', text: 'From before recipients were kept.' });
  const mention = say({ kind: 'agent', sessionId: beta.id, handle: 'beta', text: `@alpha ${LONG}`, status: 'done' });
  say({ kind: 'agent', sessionId: beta.id, handle: 'beta', text: LONG, status: 'done' });
  say({ kind: 'agent', sessionId: beta.id, handle: 'beta', text: 'Half a report.', status: 'failed', error: 'The process exited.' });
  const card = blocks(say, beta);
  say({ kind: 'voice', text: 'Looks right.', quote: 'All rows match.' });
  say({ kind: 'shared', fromTitle: 'Side work', handle: 'beta', question: 'Why?', text: 'Because the dates moved.' });
  say({ kind: 'system', variant: 'wake', from: 'you', to: 'beta' });
  say({ kind: 'system', variant: 'joined', to: 'gamma' });
  say({ kind: 'sidelink', from: 'alpha', to: 'beta', count: 3, sideThreadId: 'th_side', threadSummary: 'Dates moved.' });
  say({ kind: 'command', command: 'ls', cwd: '/work', text: 'a.md\n', status: 'done', exitCode: 0 });
  say({ kind: 'proposal', handle: 'beta', proposal: { handle: 'delta' } });
  say({ kind: 'hop', status: 'open', from: 'beta', to: 'alpha', text: 'Check March.', held: [{ from: 'gamma', to: 'alpha', text: 'And April.' }] });
  arrange.react(rt, t.id, card.id, '👍');
  // A topic thread on the person’s question, which beta answered in, with a summary on its line.
  const topic = arrange.putThread(rt, {
    id: newId('th'),
    projectId: t.projectId,
    title: 'Totals',
    kind: 'topic',
    parentId: t.id,
    rootItemId: asked.id,
    members: [],
    queue: [],
    createdAt: at(2),
  });
  arrange.post(rt, topic.id, { at: at(3), kind: 'agent', sessionId: beta.id, handle: 'beta', text: 'March is off by two.', status: 'done' });
  arrange.setItem(rt, t.id, asked.id, { threadSummary: 'March is off.', threadSummaryOf: 'x' });
  return { ...f, topic, mention, card, asked };
}

/** Each id, temp folder and clock time in what alpha read, as a name, so the text compares across runs. */
function named(f, text) {
  const ids = [f.t.id, f.topic.id, ...arrange.conversationThreads(f.rt, f.t.id).flatMap((id) => f.store.items(id).map((i) => i.id))];
  let out = String(text);
  ids.forEach((id, n) => {
    out = out.replaceAll(id, `<id ${n}>`);
  });
  out = out.replace(/(Each entry was checked against its receipt\. )+/g, (m) => `<receipt ×${m.length / RECEIPT.length}> `);
  return out.replace(/\/\S*?\/notes\/a\.md/g, '<project>/notes/a.md').replace(/\b\d\d:\d\d\b/g, '<hh:mm>');
}

test('what alpha reads of the room, its topic thread, a pointer and the read tools is the same, byte for byte', async () => {
  const f = room();
  const { rt, alpha, adapter } = f;
  rt.deliver(alpha.id, { kind: 'user', text: 'Go on.' });
  await settle(rt);
  rt.deliver(alpha.id, { kind: 'agent', from: '@beta', text: f.mention.text, itemId: f.mention.id });
  await settle(rt);
  rt.deliver(alpha.id, { kind: 'user', text: 'And here?' }, { threadId: f.topic.id });
  await settle(rt);
  const tools = rt.toolsFor(alpha.id);
  const read = {
    calls: adapter.calls.map((c) => ({ text: c.message.text, context: c.message.context ?? null, taskContext: c.message.taskContext ?? null })),
    conversation: tools.read_conversation({ limit: 30 }),
    topic: tools.read_conversation({ thread: f.topic.id }),
    long: tools.read_message({ id: f.mention.id, from: 100 }),
    card: tools.read_message({ id: f.card.id }),
    missing: tools.read_message({ id: 'nope' }),
  };
  const got = JSON.parse(named(f, JSON.stringify(read)));
  assert.deepEqual(got, EXPECTED);
});

/** What alpha read on main before Memory was a service (2cb02fcb2). */
const EXPECTED = {
  calls: [
    {
      text: 'Go on.',
      context: [
        [
          '[Postbox] What happened in this room since your last turn:',
          'The person, to @alpha, @beta: Which totals differ? [attached: notes/a.md at <project>/notes/a.md]',
          'The person: From before recipients were kept.',
          '@beta: @alpha The audit of the ledger, part by part. <receipt ×60> ',
          '@beta: The audit of the ledger, part by part. <receipt ×44> Each entry was checked ag… (2,000 of 2,679 characters; read_message { id: "<id 5>" } has the rest)',
          '@beta (this reply failed: The process exited.): Half a report.',
          '@beta showed a card block “Totals”:\nTwo differ.',
          '- Rows: 12',
          'Buttons: Fine',
          '@beta showed a choice block:\nWhich first?',
          'Options: March · April',
          'The person answered: April',
          '@beta showed a form block:\nDetails',
          'Fields:\n- Name (text, required)\n- Sync (toggle)',
          'The person answered:\n- Name: Ada\n- Sync: on',
          '@beta showed a code block:\na.js:\n```js\nlet a = 1;\n```',
          '@beta showed a review block “Draft”:\nThe totals.',
          'Comments on line 1 (open):\n- The person: Which?\n- @beta: Row 4.',
          'The person’s review: Changes asked\n- line 1: Recount.',
          '@beta showed a confirm block:\nShip it?',
          '@beta withdrew it: Not needed.',
          'The person: Looks right.\nThe app’s own summary, not the person’s words: “All rows match.”',
          'Shared from the thread “Side work”, by @beta: The person asked: “Why?” Because the dates moved.',
          'The person woke @beta',
          '@gamma joined',
          '@alpha and @beta talked in a side thread (3 messages; in short, as a model summarized it: “Dates moved.”; read_conversation with thread: "th_side" reads it)',
          'The person ran `ls` in /work (it exited with 0). Output:\n```\na.md',
          '```',
          '@beta proposed a new teammate, @delta',
          'The thread “Totals” has new messages (1 in all; in short, as a model summarized it: “March is off.”; read_conversation with thread: "<id 1>" reads it).',
          'The person reacted 👍 to @beta’s block at <hh:mm>: “Totals”',
          '@beta’s message to you (“Check March.”) is held on @beta’s request to wake @alpha (since <hh:mm> UTC), waiting for the person.',
          '@gamma’s message to you (“And April.”) is held on @beta’s request to wake @alpha (since <hh:mm> UTC), waiting for the person.',
        ].join('\n\n'),
      ],
      taskContext: null,
    },
    {
      text: '@beta’s message above, which your last summary gave you in full: “@alpha The audit of the ledger, part by part. <receipt ×3> Each entry was checke…”. It’s addressed to you: act on it now if you haven’t. read_message { id: "<id 4>" } has it whole.',
      context: [
        [
          '[Postbox] What happened in this room since your last turn:',
          '@beta’s message to you (“Check March.”) is held on @beta’s request to wake @alpha (since <hh:mm> UTC), waiting for the person.',
          '@gamma’s message to you (“And April.”) is held on @beta’s request to wake @alpha (since <hh:mm> UTC), waiting for the person.',
        ].join('\n\n'),
      ],
      taskContext: null,
    },
    {
      text: 'And here?',
      context: [
        [
          '[Postbox] Meanwhile in the room and other background context (answer room work in the room):',
          '[Postbox] What happened in this room since your last turn:',
          '@beta’s message to you (“Check March.”) is held on @beta’s request to wake @alpha (since <hh:mm> UTC), waiting for the person.',
          '@gamma’s message to you (“And April.”) is held on @beta’s request to wake @alpha (since <hh:mm> UTC), waiting for the person.',
        ].join('\n\n'),
      ],
      taskContext: [
        '[Postbox] You’re answering in the thread “Totals” (thread <id 1>). This thread started from the person’s message to @alpha, @beta: Which totals differ? [attached: notes/a.md at <project>/notes/a.md]',
        'What was said there since you last took part:',
        '@beta: March is off by two.',
      ].join('\n\n'),
    },
  ],
  conversation: {
    ok: true,
    message: [
      '[<id 2>] The person, to @alpha, @beta: Which totals differ? [attached: notes/a.md at <project>/notes/a.md]',
      '[<id 3>] The person: From before recipients were kept.',
      '[<id 4>] @beta: @alpha The audit of the ledger, part by part. <receipt ×44> Each entry was che… (2,000 of 2,686 characters; read_message { id: "<id 4>" } has the rest)',
      '[<id 5>] @beta: The audit of the ledger, part by part. <receipt ×44> Each entry was checked ag… (2,000 of 2,679 characters; read_message { id: "<id 5>" } has the rest)',
      '[<id 6>] @beta (this reply failed: The process exited.): Half a report.',
      '[<id 7>] @beta showed a card block “Totals”:\nTwo differ.',
      '- Rows: 12',
      'Buttons: Fine',
      '[<id 8>] @beta showed a choice block:\nWhich first?',
      'Options: March · April',
      'The person answered: April',
      '[<id 9>] @beta showed a form block:\nDetails',
      'Fields:\n- Name (text, required)\n- Sync (toggle)',
      'The person answered:\n- Name: Ada\n- Sync: on',
      '[<id 10>] @beta showed a code block:\na.js:\n```js\nlet a = 1;\n```',
      '[<id 11>] @beta showed a review block “Draft”:\nThe totals.',
      'Comments on line 1 (open):\n- The person: Which?\n- @beta: Row 4.',
      'The person’s review: Changes asked\n- line 1: Recount.',
      '[<id 12>] @beta showed a confirm block:\nShip it?',
      '@beta withdrew it: Not needed.',
      '[<id 13>] The person: Looks right.\nThe app’s own summary, not the person’s words: “All rows match.”',
      '[<id 14>] Shared from the thread “Side work”, by @beta: The person asked: “Why?” Because the dates moved.',
      '[<id 15>] The person woke @beta',
      '[<id 17>] @alpha and @beta talked in a side thread (3 messages; in short, as a model summarized it: “Dates moved.”; read_conversation with thread: "th_side" reads it)',
      '[<id 18>] The person ran `ls` in /work (it exited with 0). Output:\n```\na.md',
      '```',
      '[<id 19>] @beta proposed a new teammate, @delta',
      '[<id 21>] You (@alpha): ok',
      '[<id 22>] You (@alpha): ok',
    ].join('\n\n'),
  },
  topic: {
    ok: true,
    message: ['[<id 23>] @beta: March is off by two.', '[<id 24>] You (@alpha): ok'].join('\n\n'),
  },
  long: {
    ok: true,
    message: ['h entry was checked against its receipt. <receipt ×58> ', '(Characters 101–2,693 of 2,693.)'].join('\n\n'),
  },
  card: {
    ok: true,
    message: ['@beta showed a card block “Totals”:\nTwo differ.', '- Rows: 12', 'Buttons: Fine'].join('\n\n'),
  },
  missing: {
    ok: false,
    message: 'There’s no item “nope” in this conversation. Your history and read_conversation give the id of each item they cut.',
  },
};
