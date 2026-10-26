// A fake Codex app-server, for the Codex adapter’s tests (tests/codex.test.mjs, tests/codex-turn-model.test.mjs): it answers
// each request Postbox writes as the app-server does, and records them in `seen`.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export function fakeAppServer(seen, { hold = false, error = null, then = 'complete' } = {}) {
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
      if (req.method === 'initialize') child.stdout.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(req.method)) {
        const id = req.method === 'thread/fork' ? 'thr_branch' : req.method === 'thread/resume' ? req.params.threadId : 'thr_fake';
        child.stdout.write(`${JSON.stringify({ id: req.id, result: { thread: { id } } })}\n`);
      }
      if (req.method === 'turn/start') {
        child.stdout.write(`${JSON.stringify({ id: req.id, result: { turn: { id: 'turn_fake', status: 'inProgress' } } })}\n`);
        if (hold) continue;
        // A turn that fails: Codex reports why in an error notification, then ends the turn as failed, or exits.
        if (error)
          setImmediate(() => {
            child.stdout.write(`${JSON.stringify({ method: 'error', params: { error: { message: error } } })}\n`);
            if (then === 'complete')
              child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'failed' } } })}\n`);
            else child.emit('close', 1);
          });
        else
          setImmediate(() => {
            child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'reply' } })}\n`);
            child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'completed' } } })}\n`);
          });
      }
    }
  });
  return child;
}
