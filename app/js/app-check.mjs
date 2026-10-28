// The pre-display check queue for agent-written apps. Hidden frames report two widths before an app is shown.

import { api, client } from './client.mjs';

const checks = new Map(); // `${appId}:${version}` → { results: Map(width → problems), frames, timer, resolve }
const failed = new Set(); // saves to the server that wait for the connection to reopen before retrying
const WIDTHS = [375, 1280];
const NO_CHECK = new URLSearchParams(location.search).has('nocheck');
let makeFrame = null;
let pauseFrames = () => [];
let resumeFrames = () => {};
let running = false;
let scheduled = false;
const after = new Set();

/** Records one hidden frame’s result. */
export function recordAppCheck(appId, version, width, problems) {
  const c = checks.get(`${appId}:${version}`);
  if (!c || c.done) return;
  c.results.set(width, problems);
  if (c.results.size === WIDTHS.length) finishCheck(appId, version);
}

function startAppCheck(appId, version) {
  const key = `${appId}:${version}`;
  if (checks.has(key)) return checks.get(key).promise;
  const c = { results: new Map(), frames: [], timer: null, done: false, attempt: 0, resolve: null, promise: null };
  c.promise = new Promise((resolve) => {
    c.resolve = resolve;
  });
  checks.set(key, c);
  launchFrames(appId, version, c);
  return c.promise;
}

function launchFrames(appId, version, check) {
  check.results.clear();
  for (const frame of check.frames) frame.remove();
  check.frames = [];
  for (const width of WIDTHS) {
    const frame = makeFrame(appId, version, { check: true, width });
    check.frames.push(frame);
    document.body.append(frame);
  }
  check.timer = setTimeout(() => {
    if (check.attempt++ === 0) return launchFrames(appId, version, check);
    for (const width of WIDTHS)
      if (!check.results.has(width))
        check.results.set(width, [{ code: 'no-answer', message: `The app didn’t finish loading within 10 seconds at ${width} px.` }]);
    finishCheck(appId, version);
  }, 10_000);
}

async function finishCheck(appId, version) {
  const key = `${appId}:${version}`;
  const c = checks.get(key);
  if (!c || c.done) return;
  c.done = true;
  clearTimeout(c.timer);
  for (const frame of c.frames) frame.remove();
  const seen = new Set();
  const problems = [...c.results.values()].flat().filter((problem) => {
    const key = problem.code + problem.message;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  try {
    await api(`/api/apps/${encodeURIComponent(appId)}/check`, { version, problems });
  } catch {
    try {
      await api(`/api/apps/${encodeURIComponent(appId)}/check`, { version, problems });
    } catch {
      checks.delete(key);
      failed.add(key);
    }
  } finally {
    c.resolve();
  }
}

function pending() {
  return Object.values(client.state?.apps ?? {}).filter(
    (app) => !app.retired && app.check.status === 'pending' && !checks.has(`${app.id}:${app.current}`) && !failed.has(`${app.id}:${app.current}`),
  );
}

async function drain() {
  if (running || NO_CHECK || !makeFrame) return;
  running = true;
  const paused = pauseFrames();
  try {
    while (pending().length) {
      const app = pending()[0];
      await startAppCheck(app.id, app.current);
    }
  } finally {
    running = false;
    resumeFrames(paused);
    for (const fn of after) fn();
    after.clear();
  }
}

function schedule() {
  if (scheduled || running || NO_CHECK) return;
  scheduled = true;
  queueMicrotask(async () => {
    scheduled = false;
    if (!pending().length) return;
    if (navigator.locks) await navigator.locks.request('postbox-app-check', { ifAvailable: true }, (lock) => lock && drain());
    else await drain();
  });
}

/** Starts checks for every pending app, including apps in conversations or topic threads this page hasn’t opened. */
export function installAppChecks(frame, { pause, resume } = {}) {
  makeFrame = frame;
  if (pause) pauseFrames = pause;
  if (resume) resumeFrames = resume;
  client.on((change) => {
    if (change.type === 'connection' && client.connection === 'open') failed.clear();
    if (change.type === 'load' || change.type === 'app' || (change.type === 'connection' && client.connection === 'open')) schedule();
  });
  schedule();
}

export const appChecksRunning = () => running;
export function afterAppChecks(fn) {
  after.add(fn);
}
