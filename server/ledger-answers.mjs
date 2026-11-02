// The work ledger’s answers to the page (#132): a file’s diff, a command’s output, and the person’s restore of a file.
// Moved from server/ledger.mjs, whose Ledger keeps a method that delegates to each function here.

import { diffRows, hunks, MAX_DIFF_ROWS } from '../shared/work.mjs';
import { fail, known, sameSnap } from './ledger-io.mjs';
import { onHost } from './ledger-remote.mjs';
import { newId } from './store.mjs';

/**
 * One entry of a conversation's work as the page has it: what was published, never an entry still held behind a commit
 * (#601, designs/508/601-held-view.md §4). Every answer here reads through it; recording, in ledger.mjs, reads pending.
 * @param {import('./ledger.mjs').Ledger} ledger @param {string} convId @param {string} id
 */
const published = (ledger, convId, id) => ledger.s.work?.[convId]?.find((e) => e.id === id);

/**
 * A file’s diff: what all the agents’ turns left (against before their first change), or one change’s. Rows are
 * hunks from shared/work.mjs, at most MAX_DIFF_ROWS.
 * @param {import('./ledger.mjs').Ledger} ledger @param {string} convId @param {string} fileId @param {string|null} [changeId]
 */
export async function fileDiff(ledger, convId, fileId, changeId = null) {
  const f = published(ledger, convId, fileId);
  if (f?.kind === 'edit') throw onHost(f);
  if (f?.kind !== 'file') throw fail(404, 'That file isn’t in this conversation’s work.');
  const c = changeId ? published(ledger, convId, changeId) : null;
  if (changeId && (c?.kind !== 'change' || c.fileId !== fileId)) throw fail(404, 'That change isn’t in this conversation’s work.');
  const a = c ? c.before : f.before;
  const b = c ? c.after : f.after;
  const sizes = { before: { exists: Boolean(a?.exists), size: a?.size ?? null }, after: { exists: Boolean(b?.exists), size: b?.size ?? null } };
  if (!known(a) || !known(b)) return { ...sizes, tooLarge: true };
  if (a.binary || b.binary) return { ...sizes, binary: true };
  const rows = hunks(diffRows(await ledger.textOf(a), await ledger.textOf(b)));
  return { ...sizes, rows: rows.slice(0, MAX_DIFF_ROWS), cut: rows.length > MAX_DIFF_ROWS };
}

/** A command’s output, as text. @param {import('./ledger.mjs').Ledger} ledger @param {string} convId @param {string} entryId */
export async function output(ledger, convId, entryId) {
  const e = published(ledger, convId, entryId);
  if (e?.kind !== 'command') throw fail(404, 'That command isn’t in this conversation’s work.');
  if (!e.output?.sha256) return '';
  return (await ledger.blobs.get(e.output.sha256)).toString('utf8');
}

/**
 * Puts a file back the way it was before the agents first changed it, or removes it if they created it. It refuses
 * when the file changed since their last change, so nobody’s newer work is overwritten.
 */
/** @param {import('./ledger.mjs').Ledger} ledger @param {string} convId @param {string} fileId */
export async function restore(ledger, convId, fileId) {
  const f = published(ledger, convId, fileId); // the person aims it at the file as the Work view shows it
  if (f?.kind === 'edit') throw onHost(f);
  if (f?.kind !== 'file') throw fail(404, 'That file isn’t in this conversation’s work.');
  if (!known(f.before)) throw fail(409, `Postbox didn’t keep a copy of ${f.rel} from before: it was ${f.before?.big ? 'larger than 4 MB' : 'unreadable'}.`);
  if (sameSnap(f.before, f.after)) throw fail(409, `${f.rel} is already as it was before.`);
  const now = await ledger.capture(await ledger.io.read(f.path));
  if (!sameSnap(now, f.after))
    throw fail(
      409,
      `${f.rel} changed after the agents’ last change to it, so Postbox won’t overwrite it. Its diff still shows what they did, if you want to undo it yourself.`,
    );
  if (f.before.exists) await ledger.io.writeAtomic(f.path, await ledger.blobs.get(f.before.sha256));
  else await ledger.io.remove(f.path);
  const at = ledger.now();
  ledger.patch(convId, f.id, { after: f.before, added: 0, deleted: 0, restored: { at } });
  ledger.add(convId, { kind: 'restore', id: newId('wr'), fileId: f.id, path: f.path, at, removed: !f.before.exists });
  return ledger.entry(convId, f.id);
}
