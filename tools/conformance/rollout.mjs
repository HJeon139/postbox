// Reads what Codex saved of a thread: its rollout files under $CODEX_HOME/sessions (#585). The conformance probe
// counts where its marker is in them, to confirm the guide Postbox sent is what Codex keeps for the model.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { developerTexts, occurrences } from './markers.mjs';

/**
 * Every rollout file under a CODEX_HOME’s sessions folder, or none when Codex saved nothing.
 * @param {string} codexHome @returns {Promise<string[]>}
 */
export async function rolloutFiles(codexHome) {
  const root = join(codexHome, 'sessions');
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch((e) => {
    if (e.code === 'ENOENT') return []; // Codex writes no rollout until the thread has items
    throw e;
  });
  return entries.filter((e) => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)).map((e) => join(e.parentPath, e.name));
}

/** A rollout line’s item, when it is a message with a role. @param {any} line */
const messageOf = (line) => (line?.type === 'response_item' && line.payload?.type === 'message' ? line.payload : null);

/**
 * Where `marker` is in a rollout: how many times in developer messages, and how many times in any other line. A
 * line that isn’t JSON counts as other, so a broken file can’t pass. `whole`: how many developer texts hold the
 * whole guide, so a guide cut short can’t pass on its marker.
 * @param {string} text  the rollout file’s text, one JSON object a line @param {string} marker @param {string} [guide]
 * @returns {{ developer: number, elsewhere: number, whole: number }}
 */
export function rolloutMarkers(text, marker, guide) {
  let developer = 0;
  let elsewhere = 0;
  let whole = 0;
  for (const raw of text.split('\n')) {
    const n = occurrences(raw, marker);
    if (!n) continue;
    let line = null;
    try {
      line = JSON.parse(raw);
    } catch {
      line = null; // a half-written line: counted below as elsewhere
    }
    const message = messageOf(line);
    if (message?.role !== 'developer') {
      elsewhere += n;
      continue;
    }
    developer += n;
    if (guide) whole += developerTexts([message]).filter((t) => t.includes(guide)).length;
  }
  return { developer, elsewhere, whole };
}

/**
 * The marker’s counts over every rollout in a CODEX_HOME, with how many files there were.
 * @param {string} codexHome @param {string} marker @param {string} [guide]
 */
export async function savedMarkers(codexHome, marker, guide) {
  const files = await rolloutFiles(codexHome);
  const total = { files: files.length, developer: 0, elsewhere: 0, whole: 0 };
  for (const file of files) {
    const counts = rolloutMarkers(await readFile(file, 'utf8'), marker, guide);
    total.developer += counts.developer;
    total.elsewhere += counts.elsewhere;
    total.whole += counts.whole;
  }
  return total;
}
