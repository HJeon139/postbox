// The daemon’s own check of the claude a remote turn runs on (server/remote/host/daemon-claude.mjs, #1084): the
// laptop’s welcome is cached for the life of the connection, so the host decides at each start, from the claude it
// finds then, and never spawns one older than REMOTE_CLAUDE_MIN, whatever the start carries.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { hello, PROGRAMS_FOUND, setup, startMsg, until } from './remote-daemon-setup.mjs';

/** A findPrograms whose claude is at `version` (null: none read). */
const claudeAt = (version) => async () => {
  const found = structuredClone(PROGRAMS_FOUND);
  found.harnesses[0] = { ...found.harnesses[0], version };
  return found;
};

/** A readVersion that answers `answer` and records each path it was asked for. */
function reads(answer) {
  const asked = [];
  const readVersion = async ({ path }) => {
    asked.push(path);
    return answer;
  };
  return { asked, readVersion };
}

/** Sends a start for `turn` and waits for its answer: `started`, or the start’s `error`. */
async function answerTo(c, turn, over = {}) {
  c.send('start', startMsg(turn, over));
  // An error without a turn is a refused message, which answers it too.
  const answer = () => c.msgs.messages.find((m) => (m.type === 'started' && m.turn === turn) || (m.type === 'error' && (m.turn ?? turn) === turn));
  await until(answer, `the answer to ${turn}’s start`);
  return answer();
}

/** Asserts nothing started for `turn`: no runner launched, no turn folder or start.json. */
function nothingStarted(s, turn) {
  assert.deepEqual(s.launches, [], 'no runner was launched');
  assert.equal(existsSync(s.p.turn(turn)), false, 'no turn folder, so no start.json');
}

const NEED_REMOTE = { min: '2.1.187', why: 'remote' };
const NEED_DENY = { min: '2.1.259', why: 'denyPrompts' };

test('#1084: a claude still older than the minimum when read again is refused with the laptop’s words, and nothing is spawned', async () => {
  const r = reads({ version: '2.1.100' });
  const s = setup({ findPrograms: claudeAt('2.1.100'), readVersion: r.readVersion });
  try {
    const c = await hello(s);
    const answer = await answerTo(c, 't1', { need: NEED_REMOTE });
    assert.equal(answer.type, 'error');
    assert.equal(answer.code, 'start-failed');
    assert.equal(
      answer.message,
      'Claude Code 2.1.100 at /home/user/.local/bin/claude on the host is older than 2.1.187, which remote turns need. Update it there with claude update.',
    );
    assert.deepEqual(r.asked, ['/home/user/.local/bin/claude'], 'its --version was read again, once');
    nothingStarted(s, 't1');
  } finally {
    s.done();
  }
});

test('#1084: a claude updated in place since the hello is read again, spawned, and remembered for the next turn', async () => {
  const r = reads({ version: '2.1.296' });
  const s = setup({ findPrograms: claudeAt('2.1.100'), readVersion: r.readVersion });
  try {
    const c = await hello(s);
    assert.equal((await answerTo(c, 't1', { need: NEED_REMOTE })).type, 'started');
    assert.equal(s.launches.length, 1);
    assert.equal((await answerTo(c, 't2', { need: NEED_REMOTE })).type, 'started');
    assert.equal(r.asked.length, 1, 'the second turn used the version the first one read');
  } finally {
    s.done();
  }
});

test('#1084: a claude-code start with no need still can’t spawn a claude older than the remote minimum (fail closed)', async () => {
  const r = reads({ version: '2.1.186' });
  const s = setup({ findPrograms: claudeAt('2.1.186'), readVersion: r.readVersion });
  try {
    const c = await hello(s);
    const answer = await answerTo(c, 't1');
    assert.equal(answer.type, 'error');
    assert.match(answer.message, /Claude Code 2\.1\.186 .* is older than 2\.1\.187, which remote turns need/);
    nothingStarted(s, 't1');
  } finally {
    s.done();
  }
});

test('#1084: with denyPrompts’ need, a claude between the two minimums is refused with the denyPrompts words', async () => {
  const r = reads({ version: '2.1.200' });
  const s = setup({ findPrograms: claudeAt('2.1.200'), readVersion: r.readVersion });
  try {
    const c = await hello(s);
    const answer = await answerTo(c, 't1', { need: NEED_DENY });
    assert.equal(answer.type, 'error');
    assert.match(
      answer.message,
      /2\.1\.200 at \/home\/user\/\.local\/bin\/claude on the host is older than 2\.1\.259, which turning off permission prompts \(denyPrompts\) needs/,
    );
    nothingStarted(s, 't1');
  } finally {
    s.done();
  }
});

test('#1084: a claude whose version can’t be read again is refused as one of no known version', async () => {
  const r = reads({ error: 'it timed out' });
  const s = setup({ findPrograms: claudeAt(null), readVersion: r.readVersion });
  try {
    const c = await hello(s);
    const answer = await answerTo(c, 't1', { need: NEED_REMOTE });
    assert.equal(answer.type, 'error');
    assert.match(
      answer.message,
      /^Postbox couldn’t tell the version of Claude Code at \/home\/user\/\.local\/bin\/claude on the host \(it said nothing\)\. It needs 2\.1\.187 or later/,
    );
    nothingStarted(s, 't1');
  } finally {
    s.done();
  }
});

test('#1084: a claude still missing once the login shell is asked again is refused with the laptop’s words', async () => {
  const missing = async () => {
    const found = structuredClone(PROGRAMS_FOUND);
    found.harnesses[0] = { name: 'claude-code', path: null, version: null, looked: ['/home/user/.local/bin/claude', '/usr/bin/claude'] };
    return found;
  };
  const s = setup({ findPrograms: missing });
  try {
    const c = await hello(s);
    const answer = await answerTo(c, 't1', { need: NEED_REMOTE });
    assert.equal(answer.code, 'no-harness');
    assert.equal(
      answer.message,
      'Claude Code isn’t installed on the host. It looked in /home/user/.local/bin/claude, /usr/bin/claude. Install it there, or set claudePath in the host’s settings.',
    );
    nothingStarted(s, 't1');
  } finally {
    s.done();
  }
});

test('#1084: a Codex start and a claude at the minimum are unchanged: nothing is read again', async () => {
  const r = reads({ version: '1.0.0' });
  const s = setup({ findPrograms: claudeAt('2.1.187'), readVersion: r.readVersion });
  try {
    const c = await hello(s);
    assert.equal((await answerTo(c, 't1', { need: NEED_REMOTE })).type, 'started');
    assert.equal((await answerTo(c, 't2', { harness: 'codex' })).type, 'started');
    assert.deepEqual(r.asked, []);
  } finally {
    s.done();
  }
});
