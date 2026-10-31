// The old store’s files, for the import (server/store-import.mjs): which they are, reading them as the old store did,
// their backup, and the renames that mark them imported.

import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { apply, emptyState, ownState } from '../shared/state.mjs';
import { storable, wellFormed } from '../shared/storable.mjs';
import { roundStateCosts } from './store-docs.mjs';

/** storable() with its depth check off: the log’s events go into a stream, which takes any text; only their documents nest. */
const ANY_DEPTH = { jsonDepth: Number.POSITIVE_INFINITY };

/** The old store’s files in a data folder, the log’s segments in order. @param {string} dir */
export async function oldFiles(dir) {
  const names = await readdir(dir);
  const segments = names.filter((n) => /^events-\d+\.jsonl$/.test(n)).sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)));
  const base = names.includes('snapshot.json') ? ['snapshot.json'] : names.includes('store.json') ? ['store.json'] : [];
  return [...base, ...segments];
}

/**
 * The state the old store loaded, and the log’s events after its snapshot, with text cut inside a character repaired
 * (U+FFFD) in both; `repaired` counts the events it repaired, and whether the snapshot needed it; `hash` is the files’
 * SHA-256, which tells these files from another store’s at the next start, and `files` each one’s name and SHA-256, so a
 * start can tell which of them an import recorded covered.
 * @param {string} dir @param {string[]} files
 */
export async function readOld(dir, files) {
  const hash = createHash('sha256');
  /** @type {{ name: string, hash: string }[]} */ const hashes = [];
  /** @param {string} name @param {string} text */
  const read = (name, text) => {
    hash.update(text);
    hashes.push({ name, hash: createHash('sha256').update(text).digest('hex') });
  };
  let state = emptyState();
  if (files[0] === 'snapshot.json' || files[0] === 'store.json') {
    const text = await readFile(join(dir, files[0]), 'utf8');
    read(files[0], text);
    state = ownState({ ...emptyState(), ...JSON.parse(text) });
  }
  // The snapshot’s documents, before the log’s events add to them: those are repaired as they’re read.
  const snapshotCut = !!storable(JSON.stringify(state), ANY_DEPTH);
  if (snapshotCut) wellFormed(state);
  const events = [];
  let eventsCut = 0;
  const segments = files.filter((f) => f.startsWith('events-'));
  for (const name of segments) {
    const text = await readFile(join(dir, name), 'utf8');
    read(name, text);
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        // A torn last line: the old server stopped mid-write. One with lines after it, or in a segment before the last,
        // is damage the person should hear of, as the old store said; the rest of that segment is skipped, as it was.
        const rest = lines.slice(i + 1).filter((l) => l.trim()).length;
        if (rest || name !== segments.at(-1))
          console.error(`Line ${i + 1} of ${join(dir, name)} isn’t JSON, so the import skipped it and the ${rest} line(s) after it in that file.`);
        break;
      }
      if (ev.seq <= state.seq) continue;
      // JSON.stringify wrote a lone surrogate as its \udXXX escape, which the line still holds; the repaired event is
      // what the state, the stream and a browser replaying it get, so all three hold the same text.
      let kept = line;
      if (storable(line, ANY_DEPTH)) {
        eventsCut++;
        kept = JSON.stringify(wellFormed(ev));
      }
      apply(state, ev.type, ev.data);
      state.seq = ev.seq;
      events.push({ seq: ev.seq, line: kept });
    }
  }
  // The documents hold costs rounded as the store rounds them when it takes an event in; the old log keeps its events
  // as they were.
  return { state: roundStateCosts(state), events, repaired: { snapshot: snapshotCut, events: eventsCut }, hash: hash.digest('hex'), files: hashes };
}

/**
 * Copies the old files into the backup folder, the one an import cut short began or a new dated one. The backup is a
 * whole copy of every conversation: only the person may open it (0700), whatever the data folder’s mode.
 * @param {string} dir @param {string[]} files @param {string | null} marked @param {Date} now
 */
export async function backUp(dir, files, marked, now) {
  const backup = marked ?? join(dir, 'backups', `store-${now.toISOString().slice(0, 19).replace(/:/g, '-')}`);
  await mkdir(join(dir, 'backups'), { recursive: true, mode: 0o700 });
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await chmod(backup, 0o700);
  for (const f of files) {
    await copyFile(join(dir, f), join(backup, f));
    await chmod(join(backup, f), 0o600);
  }
  return backup;
}

/** Renames the old files *.migrated: imported, and the person’s record. @param {string} dir @param {string[]} files */
export async function markMigrated(dir, files) {
  for (const f of files) await rename(join(dir, f), join(dir, `${f}.migrated`));
}
