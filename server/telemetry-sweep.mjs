// The 30-day rule for telemetry (designs/telemetry-persona.md, R11): each stream and draft last written more than 30
// days ago goes, and each event recorded that long ago; a recording with nothing newer goes with its ref map; and a
// folder whose conversation is gone goes whole. Other clones’ folders in the person’s Postbox folder are aged too.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { postboxHome } from './home.mjs';
import { CONV_DIR, KEEP_MS, lostOf, telemetryRoot, write } from './telemetry.mjs';

/**
 * The 30-day rule (R11): each stream and draft last written more than 30 days ago is deleted, and each event recorded
 * that long ago; a recording with nothing newer goes with its ref map. A folder whose conversation is gone goes whole,
 * saved reports included, as when it was deleted while Postbox wasn’t running. Returns the paths it deleted.
 */
export function sweep(rt, now = Date.now()) {
  const root = telemetryRoot(rt);
  if (!root || !existsSync(root)) return [];
  const gone = [];
  for (const name of readdirSync(root).filter((n) => CONV_DIR.test(n))) {
    try {
      gone.push(...sweepOne(rt, root, name, now));
    } catch {
      lostOf(rt).sweep = true;
    }
  }
  return gone;
}

/**
 * Other clones’ telemetry folders in the person’s Postbox folder, by age only (R11): nobody else may run to age them
 * once a clone is moved or removed. Their conversations aren’t this store’s, so none is deleted for being unknown, and
 * saved reports stay. Returns what it deleted.
 */
export function sweepClones(rt, now = Date.now(), home = postboxHome()) {
  const own = telemetryRoot(rt);
  const gone = [];
  for (const n of existsSync(home) ? readdirSync(home) : []) {
    const root = join(home, n);
    if (!/^telemetry-clone-[0-9a-f]{12}$/.test(n) || root === own) continue;
    for (const name of readdirSync(root).filter((x) => CONV_DIR.test(x)))
      try {
        gone.push(...sweepOne(rt, root, name, now, { orphans: false }).map((p) => join(n, p)));
      } catch {
        lostOf(rt).sweep = true;
      }
  }
  return gone;
}

/** The 30-day rule for one conversation’s folder: what it deleted. orphans: a folder whose conversation is gone goes too. */
function sweepOne(rt, root, name, now, { orphans = true } = {}) {
  if (orphans && !rt.s.threads[name]) {
    rmSync(join(root, name), { recursive: true, force: true });
    return [name];
  }
  const rec = join(root, name, 'recording');
  if (!existsSync(rec)) return [];
  const gone = [];
  const old = [...filesIn(join(rec, 'streams')), ...filesIn(join(rec, 'drafts'))].filter((f) => now - statSync(f).mtimeMs > KEEP_MS);
  for (const f of old) {
    rmSync(f, { force: true });
    gone.push(relative(root, f));
  }
  ageEvents(join(rec, 'events.jsonl'), now);
  const rest = filesIn(rec);
  const fresh = rest.length ? rest.some((f) => now - statSync(f).mtimeMs <= KEEP_MS) : now - statSync(rec).mtimeMs <= KEEP_MS;
  if (filesIn(join(rec, 'streams')).length || fresh) return gone;
  rmSync(rec, { recursive: true, force: true });
  return [...gone, relative(root, rec)];
}

/** Keeps the events recorded in the last 30 days, by when each was recorded. */
function ageEvents(file, now) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter((l) => !(now - (Number(/"t":(\d+)/.exec(l)?.[1]) || now) > KEEP_MS));
  if (kept.length < lines.length) write(file, kept.length ? `${kept.join('\n')}\n` : '');
}

/** Every file under a folder; none if it’s missing. */
function filesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)]));
}
