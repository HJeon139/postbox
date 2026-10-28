// The pre-display check: hidden frames report two widths before an app is shown.

import { api } from './client.mjs';

const checks = new Map(); // `${appId}:${v}` → { results: Map(width → problems), frames }

// ?nocheck turns off checks in this browser (a second, passive window such as a screenshot tool).
const NO_CHECK = new URLSearchParams(location.search).has('nocheck');

export function recordAppCheck(appId, version, width, problems) {
  const c = checks.get(`${appId}:${version}`);
  if (!c) return;
  c.results.set(width, problems);
  if (c.results.size === 2) finishCheck(appId, version);
}

export function startCheck(appId, version, frameFactory) {
  const key = `${appId}:${version}`;
  if (NO_CHECK || checks.has(key)) return;
  const c = { results: new Map(), frames: [] };
  checks.set(key, c);
  for (const width of [375, 1280]) {
    const frame = frameFactory(appId, version, { check: true, width });
    c.frames.push(frame);
    document.body.append(frame);
  }
  c.timer = setTimeout(() => {
    for (const width of [375, 1280])
      if (!c.results.has(width)) c.results.set(width, [{ code: 'no-answer', message: `The app didn’t finish loading within 10 seconds at ${width} px.` }]);
    finishCheck(appId, version);
  }, 10000);
}

function finishCheck(appId, version) {
  const key = `${appId}:${version}`;
  const c = checks.get(key);
  if (!c || c.done) return;
  c.done = true;
  clearTimeout(c.timer);
  for (const frame of c.frames) frame.remove();
  const seen = new Set();
  const problems = [...c.results.values()].flat().filter((problem) => {
    const problemKey = problem.code + problem.message;
    if (seen.has(problemKey)) return false;
    seen.add(problemKey);
    return true;
  });
  api(`/api/apps/${encodeURIComponent(appId)}/check`, { version, problems }).catch(() => {
    checks.delete(key);
  });
}
