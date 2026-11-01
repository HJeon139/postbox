// Reading what the archive pass moved out of the state (#305, design "Read paths": A2 to A4). The archive file's
// SHA-256 comes from a turn-archive summary in the state, never from a request, so no request names a path (I6). A
// file that is missing, damaged or for another turn answers 410, and a turn, entry or reply that isn't archived 404.

import { conversationRoot } from '../shared/conversation.mjs';
import { httpError } from './helpers.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const unreadable = () => httpError(410, 'This turn’s details couldn’t be read. The summary still has its counts.');

/** The summary entry for an archived turn, or a 404. */
function summaryOf(state, convId, turnId) {
  const s = (state.work?.[convId] ?? []).find((e) => e.kind === 'turn-archive' && e.turnId === turnId);
  if (!s) throw httpError(404, 'That turn isn’t archived.');
  return s;
}

/**
 * Reads and checks the archive file a summary names: whole (the blob store verifies its hash), version 1, and for
 * this conversation and turn.
 * @returns {Promise<{ v: 1, convId: string, turnId: string, work: any[], activity: Record<string, Record<string, any>> }>}
 */
async function readFile(blobs, convId, summary) {
  if (!HEX64.test(String(summary.sha256))) throw unreadable();
  let file;
  try {
    file = JSON.parse((await blobs.get(summary.sha256)).toString('utf8'));
  } catch {
    throw unreadable();
  }
  if (file?.v !== 1 || file.convId !== convId || file.turnId !== summary.turnId || !Array.isArray(file.work)) throw unreadable();
  return file;
}

/** An archived turn: its work entries, and its replies' activity by thread and reply. */
export async function archivedTurn(state, blobs, convId, turnId) {
  return readFile(blobs, convId, summaryOf(state, convId, String(turnId)));
}

/** One archived work entry by id, through the summary whose turn held it: one file read. */
export async function archivedEntry(state, blobs, convId, entryId) {
  const summary = (state.work?.[convId] ?? []).find((e) => e.kind === 'turn-archive' && e.entryIds?.includes(entryId));
  if (!summary) throw httpError(404, 'That entry isn’t in this conversation’s archived work.');
  const entry = (await readFile(blobs, convId, summary)).work.find((e) => e.id === entryId);
  if (!entry) throw unreadable();
  return entry;
}

/** An archived reply's activity ({ steps }), by the thread it is in and its id. */
export async function archivedActivity(state, blobs, threadId, itemId) {
  const item = (state.items?.[threadId] ?? []).find((x) => x.id === itemId);
  const sha = item?.activity?.archived;
  if (!sha) throw httpError(404, 'That reply’s steps aren’t archived.');
  const convId = conversationRoot(state.threads, threadId);
  const summary = convId && (state.work?.[convId] ?? []).find((e) => e.kind === 'turn-archive' && e.sha256 === sha);
  if (!summary) throw unreadable();
  const activity = (await readFile(blobs, convId, summary)).activity?.[threadId]?.[itemId];
  if (!activity) throw unreadable();
  return activity;
}

/** A live work entry, else one the archive pass moved out of the state, so a diff or an output still opens. @param {any} ledger */
export async function liveOrArchived(ledger, convId, id) {
  return ledger.entry(convId, id) ?? (await archivedEntry(ledger.s, ledger.blobs, convId, id).catch((e) => (e?.status === 404 ? null : Promise.reject(e))));
}
