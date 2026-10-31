// Fixtures for the Codex adapter on a remote host (#120, L4c: tests/codex-remote.test.mjs and
// tests/codex-remote-restart.test.mjs), against tests/fake-daemon.mjs through a minimal stand-in for the host link.
// No recorded remote Codex stream exists yet, so the host’s out.jsonl is built from the local recording in
// tests/fixtures/codex-app-server/turn.jsonl, and the approval request has the shape the local approval tests in
// tests/codex.test.mjs use; both are marked where they’re made.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createMessageReader, encode, message, PROTOCOL_VERSION, utf8Bytes } from '../shared/remote-protocol.mjs';
import { FAKE_TOKEN } from './fake-daemon.mjs';

export const FOLDER = '/home/user/postbox-work/critic';
/** The host’s permissionWaitMax by default (shared/remote-settings.mjs), which the context’s empty settings leave. */
export const WAIT = 24 * 60 * 60 * 1000;
/** The recorded local turn: responses to requests 1 to 3, then turn/started, a message, a command, turn/completed. */
export const RECORDED = readFileSync(new URL('fixtures/codex-app-server/turn.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean);
export const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(fn(), `Timed out waiting for ${label}`);
};
export const sent = (d, type) => d.received.filter((m) => m.type === type);

/** The host link, as far as the adapter needs it, over the fake daemon’s streams; `welcome` is the latest. */
export function linkTo(d, { delayIn = 0 } = {}) {
  const link = new EventEmitter();
  link.setMaxListeners(0);
  let ready = false;
  let stdin;
  const wire = ({ stdin: i, stdout }) => {
    stdin = i;
    ready = false;
    const reader = createMessageReader('daemon-to-postbox', {
      onMessage(m) {
        if (stdin !== i) return;
        if (m.type === 'welcome') {
          ready = true;
          link.welcome = m;
          link.emit('connected', m);
        } else if ((m.type === 'line' || m.type === 'caught-up') && m.log === 'in' && delayIn) setTimeout(() => link.emit('message', m), delayIn);
        else link.emit('message', m);
      },
      onError: (e) => assert.fail(`The fake daemon sent a bad line: ${e.message}`),
    });
    stdout.on('data', (b) => setImmediate(() => reader.push(b)));
    i.write(encode(message('postbox-to-daemon', 'hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN })));
  };
  wire({ stdin: d.stdin, stdout: d.stdout });
  return Object.assign(link, {
    /** @type {any} */
    welcome: null,
    send(msg) {
      if (!ready) return false;
      stdin.write(encode(msg));
      return true;
    },
  });
}

/**
 * Codex on the host: answers each line Postbox writes to the held stdin as the app-server does, appending to the
 * turn’s out.jsonl. `turnLines` go out after turn/start’s response (the recorded turn by default).
 */
export function codexOnHost(d, { turnLines = RECORDED.slice(3), threadId = 'thr_postbox_1', turnId = 'turn_postbox_1', resumeError = null } = {}) {
  const timer = setInterval(() => {
    for (const t of d.turns.values()) {
      if (t.harness !== 'codex') continue;
      for (; (t.seen ?? 0) < t.writes.length; t.seen = (t.seen ?? 0) + 1) {
        const req = JSON.parse(t.writes[t.seen ?? 0]);
        if (req.method === 'initialize') d.append(t.turn, JSON.stringify({ id: req.id, result: { userAgent: 'codex/0' } }));
        else if (req.method === 'mcpServerStatus/list') d.append(t.turn, JSON.stringify({ id: req.id, result: { data: [], nextCursor: null } }));
        else if (req.method === 'thread/resume' && resumeError) d.append(t.turn, JSON.stringify({ id: req.id, error: resumeError }));
        else if (req.method === 'thread/start' || req.method === 'thread/resume')
          d.append(t.turn, JSON.stringify({ id: req.id, result: { thread: { id: threadId } } }));
        else if (req.method === 'turn/start') {
          d.append(t.turn, JSON.stringify({ id: req.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } }));
          for (const l of turnLines) d.append(t.turn, l);
        } else if (req.method === 'turn/interrupt') d.append(t.turn, JSON.stringify({ id: req.id, result: {} }));
      }
    }
  }, 2);
  return { stop: () => clearInterval(timer) };
}

/** Injected local kill and ps that fail the test if a remote turn ever reaches them. */
export function forbidden() {
  const calls = [];
  return {
    calls,
    kill: (pid, sig) => {
      calls.push(['kill', pid, sig]);
      throw new Error('a remote turn reached the local kill');
    },
    list: async () => {
      calls.push(['list']);
      throw new Error('a remote turn reached the local ps');
    },
  };
}

/** Turn IDs as the runtime allocates them: unique, persisted before deliver. */
let turnIds = 0;

export function context(link, { attach, abort = new AbortController(), state = {}, asked = [], answers = [], remote = {} } = {}) {
  const turn = `cx-turn-${++turnIds}`;
  const calls = { text: '', saved: {}, asked, turns: [], next: 0 };
  return {
    calls,
    abort,
    ctx: {
      persona: { handle: 'critic', model: 'gpt-5.6-terra', effort: 'medium', permissionMode: 'ask' },
      project: { folder: '/Users/me/laptop-only' },
      handles: ['critic'],
      state,
      signal: abort.signal,
      mcpUrl: 'http://127.0.0.1:1/mcp?session=never-used',
      remote: {
        link,
        welcome: link.welcome,
        settings: {},
        folder: FOLDER,
        version: '0.10.0',
        turn,
        // One Codex deliver is one host turn: it never asks for a second.
        nextTurn: async () => {
          calls.next += 1;
          return `cx-extra-${calls.next}`;
        },
        ...(attach ? { attach } : {}),
        ...remote,
      },
      text: (text) => {
        calls.text += text;
      },
      activity: () => {},
      status: () => {},
      saveState: (s) => Object.assign(calls.saved, s),
      checkpoint: () => {},
      reported: () => {},
      pathOf: () => null,
      askPermission: async (req) => {
        asked.push(req);
        return answers.shift() ?? new Promise(() => {});
      },
    },
  };
}

export const ready = async (link) => until(() => link.welcome, 'the welcome');

/** A turn already on the host, as a Postbox before the restart left it: out.jsonl and in.jsonl. */
export function leftOnHost(d, turn, { out, inLines }) {
  const t = d.addTurn(turn, { harness: 'codex', stdin: 'held', lines: out });
  for (const text of inLines) {
    const offset = t.in.at(-1)?.next ?? 0;
    t.in.push({ offset, next: offset + utf8Bytes(text) + 1, text });
  }
  return t;
}

// The shape of the local approval tests’ request (tests/codex.test.mjs); no recorded one exists yet.
export const approval = (id, itemId, command) =>
  JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: { itemId, command, cwd: FOLDER } });
export const SENT_BEFORE = [
  '{"id":1,"method":"initialize","params":{}}',
  '{"method":"initialized","params":{}}',
  '{"id":2,"method":"thread/start","params":{}}',
  '{"id":3,"method":"turn/start","params":{}}',
];
