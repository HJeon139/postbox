// Tests for UAT log tooling (#508, plan-no-redis-1).
// Verifies verifyPrompt references to data/events-*.jsonl and snapshot.json,
// readReceived reading across disk, live state and history, and saveRecords.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveRecords } from '../tools/uat/history.mjs';
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

  // Missing handle or invalid messages return empty array
  assert.deepEqual(messagesOf({ agentMessages: [] }), []);
  assert.deepEqual(messagesOf(null), []);
});

test('readReceived merges live state, live history, and logged disk data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-read-recv-'));
  try {
    // 1. Disk store: snapshot.json with session se_disk
    const snap = {
      version: 1,
      seq: 5,
      sessions: {
        se_disk: {
          id: 'se_disk',
          handle: 'researcher',
          agentMessages: [{ dir: 'from', other: 'critic', text: 'Message from disk', at: 50 }],
        },
      },
    };
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snap));

    // 2. Live in-memory state with session se_live
    const liveState = {
      sessions: {
        se_live: {
          id: 'se_live',
          handle: 'developer',
          agentMessages: [{ dir: 'from', other: 'researcher', text: 'Message from live state', at: 100 }],
        },
      },
    };

    // 3. Live history object with received()
    const liveHistory = {
      received: () => [{ handle: 'critic', from: 'developer', text: 'Message from stream', at: 150 }],
    };

    const all = readReceived(dir, [], { state: liveState, history: liveHistory });

    assert.equal(all.length, 3);
    assert.equal(all[0].text, 'Message from disk');
    assert.equal(all[1].text, 'Message from live state');
    assert.equal(all[2].text, 'Message from stream');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveRecords writes events.jsonl and state.json to run folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-save-records-'));
  try {
    const facts = {
      events: [{ seq: 1, type: 'item.add', data: { id: 'it_1' } }],
      state: { seq: 1, personas: {} },
    };

    await saveRecords(dir, facts);

    const eventsContent = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    const stateContent = readFileSync(join(dir, 'state.json'), 'utf8');

    assert.match(eventsContent, /it_1/);
    assert.match(stateContent, /"seq":1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
