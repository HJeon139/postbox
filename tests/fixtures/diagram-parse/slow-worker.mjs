// A stand-in for server/diagram-parse-worker.mjs (critic’s review of #1642): it answers every diagram with a syntax
// error, 1.8 s later, so after the lint turn’s 1.5 s settle and well within the parser’s own time limit.
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', ({ id }) => {
  setTimeout(() => parentPort?.postMessage({ id, error: { message: 'Parse error on line 2: a slow answer', line: 2 } }), 1800);
});
