// A fake Codex app-server, for the Codex adapter’s tests (tests/codex.test.mjs, tests/codex-turn-model.test.mjs): it answers
// each request Postbox writes as the app-server does, and records them in `seen`. And app-servers that answer as a
// recording in tests/fixtures/codex-app-server/ did (tests/codex-compact.test.mjs).

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tempDir } from './temp-dirs.mjs';

/** The Codex tests’ work root, a temp folder of the test file’s: the adapter makes folders in it (#823). */
export const CODEX_ROOT = tempDir('postbox-codex-test-');

/** turn/start’s answer, then the turn’s end unless it holds. @param {any} child @param {any} req @param {any} o */
function answerStart(child, req, { hold, error, then }) {
  child.stdout.write(`${JSON.stringify({ id: req.id, result: { turn: { id: 'turn_fake', status: 'inProgress' } } })}\n`);
  if (hold) return;
  // A turn that fails: Codex reports why in an error notification, then ends the turn as failed, or exits.
  if (error)
    setImmediate(() => {
      child.stdout.write(`${JSON.stringify({ method: 'error', params: { error: { message: error } } })}\n`);
      if (then === 'complete') child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'failed' } } })}\n`);
      else child.emit('close', 1);
    });
  else
    setImmediate(() => {
      child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'reply' } })}\n`);
      child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'completed' } } })}\n`);
    });
}

export function fakeAppServer(
  seen,
  { hold = false, error = null, then = 'complete', mcpServers = [], threadError = (_req) => null, cut = (_req) => false, beforeStarted = null } = {},
) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {
    child.emit('close', 0);
    return true;
  };
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      if (!line) continue;
      const req = JSON.parse(line);
      seen.push(req);
      if (req.method === 'initialize' || req.method === 'skills/extraRoots/set') child.stdout.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
      if (req.method === 'mcpServerStatus/list')
        child.stdout.write(
          `${JSON.stringify({
            id: req.id,
            result: { data: mcpServers.map((server) => (typeof server === 'string' ? { name: server } : server)), nextCursor: null },
          })}\n`,
        );
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(req.method)) {
        // A host leaves out a line past its limit and says so (server/remote/process-receive.mjs's 'cut', #1705).
        if (cut(req)) {
          child.emit('cut', { offset: 0, next: 8_458_618 });
          continue;
        }
        const failure = threadError(req);
        if (failure) {
          child.stdout.write(`${JSON.stringify({ id: req.id, error: failure })}\n`);
          continue;
        }
        const id = req.method === 'thread/fork' ? 'thr_branch' : req.method === 'thread/resume' ? req.params.threadId : 'thr_fake';
        child.stdout.write(`${JSON.stringify({ id: req.id, result: { thread: { id } } })}\n`);
      }
      if (req.method === 'turn/start') {
        // What Codex sends before turn/start's answer, such as turn/started: the test calls `answer` when it's done.
        if (beforeStarted) beforeStarted(child, () => answerStart(child, req, { hold, error, then }));
        else answerStart(child, req, { hold, error, then });
      }
    }
  });
  return child;
}

/**
 * A recording’s answers by request id: each answer, then the notifications it had before its next answer.
 * @param {string} name @returns {Map<number, any[]>}
 */
export function answersOf(name) {
  const after = new Map();
  let answered = /** @type {any[]} */ ([]);
  for (const l of readFileSync(new URL(`fixtures/codex-app-server/${name}`, import.meta.url), 'utf8')
    .trim()
    .split('\n')) {
    const line = JSON.parse(l);
    if (line.id === undefined) answered.push(line);
    else after.set(line.id, (answered = [line]));
  }
  return after;
}

/**
 * App-servers that answer from recorded plays, one process each, as Postbox starts one per turn: each play maps a
 * request’s method to its recorded answer and the notifications after it (answersOf), and a method it doesn’t name gets
 * an empty page.
 * @param {Record<string, any[] | undefined>[]} plays @param {any[]} seen what Postbox sent @param {any[]} answered what
 *   each request got, beside it
 */
export function playedServers(plays, seen, answered) {
  return () => {
    const play = /** @type {Record<string, any[] | undefined>} */ (plays.shift() ?? {});
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => child.emit('close', 0);
    const write = (/** @type {any} */ m) => child.stdout.write(`${JSON.stringify(m)}\n`);
    child.stdin.on('data', (chunk) => {
      for (const req of chunk
        .toString()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))) {
        seen.push(req);
        if (req.id === undefined) continue;
        const [answer = { result: { data: [], nextCursor: null } }, ...notes] = play[req.method] ?? [];
        answered.push([req.method, answer]);
        write({ ...answer, id: req.id });
        setImmediate(() => notes.forEach(write));
      }
    });
    return child;
  };
}
