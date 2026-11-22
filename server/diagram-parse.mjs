// Checks a diagram’s syntax with Mermaid’s parser in a worker (#731; designs/architecture/diagram-legibility.md,
// “Syntax, checked on the server”), so its agent hears of an error without the person scrolling to it. One worker for
// the process, started by the first diagram and kept; diagrams go to it one at a time. A diagram the parser takes
// longer than PARSE_MS over ends the worker, which the next diagram starts again, and gets no answer: the drawn
// diagram still reports it.

import { Worker } from 'node:worker_threads';

/** How long one diagram may take, the worker’s start included. */
const PARSE_MS = 5000;

/** @type {Worker | null} */
let worker = null;
let next = 1;
/** @type {Map<number, (m: any) => void>} */
const waiting = new Map();
/** @type {Promise<any>} */
let queue = Promise.resolve();

function start() {
  const w = new Worker(new URL('./diagram-parse-worker.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 256 } });
  w.on('message', (m) => answer(m.id, m));
  // A worker that fails to start or dies answers nothing for what it had; the next diagram starts another.
  w.on('error', () => {});
  w.on('exit', () => {
    if (worker === w) worker = null;
    for (const id of [...waiting.keys()]) answer(id, null);
  });
  return w;
}

/** @param {number} id @param {any} m */
function answer(id, m) {
  const done = waiting.get(id);
  waiting.delete(id);
  // Only while a diagram waits does the worker keep Postbox’s process running.
  if (!waiting.size) worker?.unref();
  done?.(m);
}

/** @param {string} src @returns {Promise<{ ok?: true, error?: { message: string, line: number | null }, unknown?: true } | null>} */
function one(src) {
  worker ??= start();
  const w = worker;
  w.ref();
  const id = next++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      answer(id, null);
      w.terminate();
    }, PARSE_MS);
    waiting.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    w.postMessage({ id, src });
  });
}

/**
 * Mermaid’s syntax error for a diagram’s source, as the sandbox page would report it, or null when it parses or
 * can’t be told here. @param {string} src
 */
export function syntaxError(src) {
  const run = queue.then(() => one(src));
  queue = run.catch(() => null);
  return run.then((m) => m?.error ?? null).catch(() => null);
}
