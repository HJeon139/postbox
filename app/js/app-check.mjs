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

export function startCheck(appId, version, frame) {
  const key = `${appId}:${version}`;
  if (NO_CHECK || checks.has(key)) return;
  const c = { results: new Map(), frames: [] };
  checks.set(key, c);
  for (const w of [375, 1280]) {
    const f = frame(appId, version, { check: true, width: w });
    c.frames.push(f);
    document.body.append(f);
  }
  c.timer = setTimeout(() => {
    for (const w of [375, 1280])
      if (!c.results.has(w)) c.results.set(w, [{ code: 'no-answer', message: `The app didn’t finish loading within 10 seconds at ${w} px.` }]);
    finishCheck(appId, version);
  }, 10000);
}

function finishCheck(appId, version) {
  const key = `${appId}:${version}`;
  const c = checks.get(key);
  if (!c || c.done) return;
  c.done = true;
  clearTimeout(c.timer);
  for (const f of c.frames) f.remove();
  const seen = new Set();
  const problems = [...c.results.values()].flat().filter((p) => {
    const k = p.code + p.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  api(`/api/apps/${encodeURIComponent(appId)}/check`, { version, problems }).catch(() => {
    checks.delete(key);
  });
}
