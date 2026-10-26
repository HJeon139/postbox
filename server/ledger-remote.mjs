// What the work ledger keeps of a turn on a remote host (#120; server/ledger.mjs, the header): which host it ran on,
// the folder there, and its edits as steps, since the files are on the host and Postbox never reads them. Each
// function takes the ledger first.

import { isAbsolute, resolve } from 'node:path';
import { clip } from './ledger-git.mjs';
import { newId } from './store.mjs';

/**
 * The host a turn runs on, { id, name }, or null for this computer: the runtime has made the turn remote
 * (turn.remote), its persona runs on a host, or its session’s host turn is this one.
 * @param {any} ledger @param {any} turn @param {any} se
 */
export function hostOf(ledger, turn, se) {
  const now = ledger.s.sessions?.[se.id] ?? se;
  const r = now.remoteTurn;
  const id = [turn.remote?.hostId, ledger.s.personas?.[now.personaId]?.remote?.hostId, r?.rtTurn === turn.id ? r.hostId : null].find(
    (x) => typeof x === 'string' && x,
  );
  if (!id) return null;
  return { id, name: clip(ledger.s.hosts?.[id]?.name ?? 'its host', 200) };
}

/** The folder a host turn works in, once the runtime has given it one. @param {any} ledger @param {any} turn */
export function hostFolder(ledger, turn) {
  const w = turn.work;
  if (!w.folder) {
    const r = ledger.s.sessions?.[w.se.id]?.remoteTurn;
    if (r?.rtTurn === turn.id && typeof r.folder === 'string' && isAbsolute(r.folder)) w.folder = resolve(r.folder);
  }
  return w.folder;
}

/**
 * An edit on a host, as a step: which file, how many edits this turn, and that Postbox kept no copy of it.
 * @param {any} ledger @param {any} turn @param {{ who: string|null, path: string|null }} call
 */
export function hostEdit(ledger, turn, { who, path }) {
  const w = turn.work;
  if (!path) return;
  const id = w.edits.get(path);
  const e = id ? ledger.entry(w.convId, id) : null;
  if (e) {
    ledger.patch(w.convId, e.id, { tools: (e.tools ?? 1) + 1, at: ledger.now() });
    return;
  }
  const entry = ledger.add(
    w.convId,
    ledger.base(turn, {
      kind: 'edit',
      id: newId('we'),
      who,
      path: clip(path, 4000),
      rel: clip(ledger.display(path, w), 500),
      outside: Boolean(w.folder) && !ledger.inside(path, w),
      tools: 1,
    }),
  );
  w.edits.set(path, entry.id);
}

/** The refusal for a file on a host: Postbox never read it, so it has no diff and nothing to put back. @param {any} e */
export function onHost(e) {
  return Object.assign(
    new Error(`${e.rel} is on ${e.host?.name ?? 'a host'}, and Postbox doesn’t keep copies of files on a host: it has no diff of it and can’t restore it.`),
    { status: 409 },
  );
}
