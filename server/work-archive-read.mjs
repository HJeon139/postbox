// Reading an archived turn (#305; designs/305-archive-turns.md, “Read paths and access patterns”, A2 and A4). Every
// read of what the archive pass moved out of the state goes through archived(), which holds I6: the archive file’s
// SHA-256 comes from the turn’s summary in the state, never from a request, and the file must be that conversation’s
// and that turn’s. A turn or entry that isn’t archived is a 404; a file that is missing, damaged or another turn’s is
// a 410, and the page keeps the summary’s counts (“Opening an old turn”).

import { ledgerIndex } from '../shared/work-index.mjs';
import { httpError } from './helpers.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const UNREADABLE = 'This turn’s details couldn’t be read. Its summary still shows what it did.';
const unreadable = () => httpError(410, UNREADABLE);

/**
 * The summary entry of an archived turn, found by the turn’s id or by the id of an entry it moved, through the work
 * index (shared/work-index.mjs): no scan of the conversation’s list. Null when nothing archived matches.
 * @param {any} state  the published state @param {string} convId @param {{ turnId?: string, entryId?: string }} key
 */
function summaryOf(state, convId, key) {
  const ix = ledgerIndex(state.work?.[convId] ?? []);
  if (typeof key.entryId === 'string') return ix.archived.get(key.entryId) ?? null;
  return (ix.byTurn.get(String(key.turnId)) ?? []).find((e) => e.kind === 'turn-archive') ?? null;
}

/** The 404 for a key nothing archived matches, in the words of what was asked for. */
function notArchived(key) {
  if (typeof key.entryId === 'string') return httpError(404, 'That entry isn’t in this conversation’s archived work.');
  return httpError(404, 'That turn isn’t archived in this conversation.');
}

/**
 * The archive file a summary names, read and checked: whole (the blob store checks its bytes against the hash),
 * version 1, and for this conversation and turn. Any failure is the same 410: the file is what’s wrong.
 * @param {{ get(sha256: string): Promise<Buffer> }} blobs @param {string} convId @param {any} summary
 */
async function fileOf(blobs, convId, summary) {
  if (!HEX64.test(String(summary.sha256))) throw unreadable();
  let file;
  try {
    file = JSON.parse((await blobs.get(summary.sha256)).toString('utf8'));
  } catch {
    // Missing (ENOENT), damaged (the hash check) or not JSON: the reader can only say it couldn’t be read.
    throw unreadable();
  }
  const ours = file?.v === 1 && file.convId === convId && file.turnId === summary.turnId;
  if (!ours || !Array.isArray(file.work)) throw unreadable();
  return file;
}

/**
 * An archived turn, by its id or by the id of an entry it moved: its summary, its entries and its replies’ activity,
 * and with an entry id, that entry. Cost: one summary lookup through the work index, then one blob read and parse of
 * the turn’s file (the largest turn on the real-room copy was 243 KB, the median 0.6 KB). The caller passes the
 * published state, as what this returns leaves the process (tests/store-held-guard.test.mjs).
 * @param {any} state @param {{ get(sha256: string): Promise<Buffer> }} blobs @param {string} convId
 * @param {{ turnId?: string, entryId?: string }} key  one of the two
 * @returns {Promise<{ summary: any, turnId: string, work: any[], activity: Record<string, Record<string, any>>, entry?: any }>}
 */
export async function archived(state, blobs, convId, key) {
  const summary = summaryOf(state, convId, key);
  if (!summary) throw notArchived(key);
  const file = await fileOf(blobs, convId, summary);
  const turn = { summary, turnId: summary.turnId, work: file.work, activity: file.activity ?? {} };
  if (typeof key.entryId !== 'string') return turn;
  // The summary lists the entry, so a file without it isn’t the file the pass wrote.
  const entry = file.work.find((e) => e.id === key.entryId);
  if (!entry) throw unreadable();
  return { ...turn, entry };
}
