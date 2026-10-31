// Tests for UAT log tooling and verifier prompt (#508, designs/508/storage-design.md).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lines } from '../tools/uat/history.mjs';
import { messagesOf, readReceived } from '../tools/uat/run-files.mjs';
import { verifyPrompt } from '../tools/uat/verify-prompt.mjs';

test('verifyPrompt tells verifier to check data/events-*.jsonl and data/snapshot.json', () => {
  const prompt = verifyPrompt({
    scenario: { title: 'Delivery' },
    findings: [],
    timeline: [],
    issues: [],
  });

  assert.match(prompt, /data\/events-\*\.jsonl \(one event a line\)/);
  assert.match(prompt, /data\/snapshot\.json \(a single JSON object with the state as of that snapshot\)/);
  assert.match(prompt, /search them with Grep/);
});

test('messagesOf extracts agent messages from a session object', () => {
  const session = {
    id: 'se_1',
    handle: 'researcher',
    agentMessages: [
      { dir: 'from', other: 'critic', text: 'Hello researcher', at: 100 },
      { dir: 'to', other: 'critic', text: 'Replying to critic', at: 110 },
      { dir: 'from', other: 'developer', text: 'Hello from dev', at: 120 },
    ],
  };

  const msgs = messagesOf(session);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { handle: 'researcher', from: 'critic', text: 'Hello researcher', at: 100 });
  assert.deepEqual(msgs[1], { handle: 'researcher', from: 'developer', text: 'Hello from dev', at: 120 });

  assert.deepEqual(messagesOf({ agentMessages: [] }), []);
  assert.deepEqual(messagesOf(null), []);
});

test('readReceived parses disk log segments and unwraps array commit lines (#508, option b)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-read-recv-'));
  try {
    const snap = {
      version: 1,
      seq: 5,
      sessions: {
        se_1: {
          id: 'se_1',
          handle: 'researcher',
          agentMessages: [{ dir: 'from', other: 'critic', text: 'Initial snapshot message', at: 50 }],
        },
      },
    };
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snap));

    // Log segment with a single event line AND a multi-event commit array line
    const event1 = JSON.stringify({
      seq: 6,
      type: 'session.patch',
      data: {
        id: 'se_1',
        patch: {
          agentMessages: [
            { dir: 'from', other: 'developer', text: 'Single event line message', at: 60 },
            { dir: 'from', other: 'critic', text: 'Initial snapshot message', at: 50 },
          ],
        },
      },
    });

    const commitArray = JSON.stringify([
      {
        seq: 7,
        op: 'op_a1',
        type: 'record.open',
        data: { id: 'rec_1' },
      },
      {
        seq: 8,
        type: 'session.patch',
        data: {
          id: 'se_1',
          patch: {
            agentMessages: [
              { dir: 'from', other: 'engineer', text: 'Array commit message', at: 70 },
              { dir: 'from', other: 'developer', text: 'Single event line message', at: 60 },
              { dir: 'from', other: 'critic', text: 'Initial snapshot message', at: 50 },
            ],
          },
        },
      },
    ]);

    writeFileSync(join(dir, 'events-1.jsonl'), `${event1}\n${commitArray}\n`);

    const received = readReceived(dir);
    assert.equal(received.length, 3);
    assert.equal(received[0].text, 'Initial snapshot message');
    assert.equal(received[1].text, 'Single event line message');
    assert.equal(received[2].text, 'Array commit message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lines() in history.mjs unwraps commit array lines into flat events (#508, option b)', () => {
  const raw = [
    JSON.stringify({ seq: 1, type: 'item.add', data: { id: 'it_1' } }),
    JSON.stringify([
      { seq: 2, op: 'op_1', type: 'record.open', data: { id: 'rec_1' } },
      { seq: 3, type: 'turn.marker', data: { turnId: 'turn_1' } },
    ]),
    JSON.stringify({ seq: 4, type: 'item.add', data: { id: 'it_2' } }),
  ].join('\n');

  const parsed = lines(raw);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].seq, 1);
  assert.equal(parsed[1].seq, 2);
  assert.equal(parsed[1].op, 'op_1');
  assert.equal(parsed[2].seq, 3);
  assert.equal(parsed[3].seq, 4);
});
