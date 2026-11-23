// Checks a diagram’s syntax with Mermaid’s parser in a worker (#731; designs/architecture/diagram-legibility.md,
// “Syntax, checked on the server”), so its agent hears of an error without the person scrolling to it. One worker for
// the process, started by the first diagram and kept; diagrams go to it one at a time. A diagram the parser takes
// longer than PARSE_MS over ends the worker, which the next diagram starts again, and gets no answer: the drawn
// diagram still reports it.

import { Worker } from 'node:worker_threads';

/** The worker’s script, and how long one diagram may take, its start included; a test sets its own (useParser). */
let script = new URL('./diagram-parse-worker.mjs', import.meta.url);
let parseMs = 5000;

/** @type {Worker | null} */
let worker = null;
let next = 1;
/** Each diagram sent, by its id: the worker it went to, and what takes its answer. */
/** @type {Map<number, { w: Worker, done: (m: any) => void }>} */
const waiting = new Map();
/** @type {Promise<any>} */
let queue = Promise.resolve();

function start() {
  const w = new Worker(script, { resourceLimits: { maxOldGenerationSizeMb: 256 } });
  w.on('message', (m) => answer(m.id, m));
  // A worker that fails to start or dies answers nothing for what it had; the next diagram starts another.
  w.on('error', () => {});
  w.on('exit', () => {
    if (worker === w) worker = null;
    // Only its own diagrams: one sent to the worker after it may be waiting too.
    for (const [id, sent] of [...waiting]) if (sent.w === w) answer(id, null);
  });
  return w;
}

/** @param {number} id @param {any} m */
function answer(id, m) {
  const sent = waiting.get(id);
  waiting.delete(id);
  // Only while a diagram waits does the worker keep Postbox’s process running.
  if (!waiting.size) worker?.unref();
  sent?.done(m);
}

/** @param {string} src @returns {Promise<{ ok?: true, error?: { message: string, line: number | null }, unknown?: true } | null>} */
function one(src) {
  worker ??= start();
  const w = worker;
  w.ref();
  const id = next++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Forgotten first, so the next diagram, which answering starts, goes to a new worker, not this one as it ends.
      if (worker === w) worker = null;
      answer(id, null);
      w.terminate();
    }, parseMs);
    waiting.set(id, {
      w,
      done: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
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

/**
 * For a test: the worker script to run and the time limit, with any worker running now ended.
 * @param {{ url: URL, ms: number }} parser
 */
export function useParser({ url, ms }) {
  worker?.terminate();
  worker = null;
  script = url;
  parseMs = ms;
}
