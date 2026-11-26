// What the idleroom scenario’s nightly check did, and when (#1746): tests/uat/e2e/fixtures/nightly/nightly.mjs keeps a
// line each time it’s queued and each time it finishes, in the workspace’s .git folder, which the run keeps with the
// workspace; a recheck reads the kept copy, since the folder the run worked in is gone by then. Read from there, not
// from an agent’s stream, so it’s the same on every backend and a command an agent chained or piped still counts. The
// checks and triggers read it as when the timed step started and was due, and when the scenario’s definition of done
// was first met (tools/uat/quiet-stretches.mjs).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The check’s history in a workspace, oldest first; none when the run had no such check. @param {string|null|undefined} workspace */
export function nightlyLog(workspace) {
  const path = workspace ? join(workspace, '.git', 'nightly-log.jsonl') : null;
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The person’s request names the script that proves the work is done. */
export const ASKED = /\bnightly\.mjs\b/;

/**
 * When the person asked for the work (their first message that names the script), when its timed step was first
 * queued and due, and when it first passed. A pass counts only for a check queued before it, as the script only runs
 * one that was.
 * @param {{ workspace?: string|null, workspaceKept?: string|null, events?: any[] }} f  @returns {import('./quiet-stretches.mjs').Work}
 */
export function nightlyWork(f) {
  const request = (f.events ?? []).find((e) => e?.type === 'item.add' && e.data?.item?.kind === 'user' && ASKED.test(e.data.item.text ?? ''));
  const log = nightlyLog(f.workspaceKept ?? f.workspace);
  const queued = log.find((x) => x.did === 'queued') ?? null;
  const passed = queued ? (log.find((x) => x.did === 'passed' && x.at >= queued.at) ?? null) : null;
  return {
    asked: request?.data.item.at ?? null,
    queued: queued ? { at: queued.at, due: Number.isFinite(queued.due) ? queued.due : null } : null,
    passed: passed ? { at: passed.at } : null,
  };
}
