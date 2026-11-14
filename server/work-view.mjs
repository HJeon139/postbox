// The work ledger’s answers to the page (#132): what a conversation’s agents changed, ran and published, read by the
// Work view, and the file it puts back. A conversation is the one a thread belongs to: its side and topic threads
// count toward it. Work (server/work-service.mjs) calls each with itself.

import { httpError } from './helpers.mjs';

/** An error the ledger raised with a status, as the API answers it. */
const asHttp = (e) => {
  throw e?.status ? httpError(e.status, e.message) : e;
};

/** @param {import('./work-service.mjs').Work} work @param {string} threadId */
function workConversation(work, threadId) {
  const t = work.threads.get(threadId);
  if (t.kind === 'side' || t.kind === 'topic') throw httpError(404, 'Open the conversation this thread belongs to: its work is there.');
  return t.id;
}
/** Where each changed file and commit stands in git now (read-only). */
export function workGit(work, threadId) {
  return work.ledger.gitState(workConversation(work, threadId));
}
/** @param {string} threadId @param {string} fileId @param {string|null} [changeId] */
export function workDiff(work, threadId, fileId, changeId = null) {
  return work.ledger.fileDiff(workConversation(work, threadId), fileId, changeId).catch(asHttp);
}
export function workOutput(work, threadId, entryId) {
  return work.ledger.output(workConversation(work, threadId), entryId).catch(asHttp);
}
/**
 * Puts a file back as it was before the agents first changed it (or removes one they created), and says so in the
 * conversation, so its agents read it on their next turn.
 */
export async function restoreWork(work, threadId, fileId) {
  const convId = workConversation(work, threadId);
  const f = await work.ledger.restore(convId, fileId).catch(asHttp);
  const who = f?.handles?.length ? f.handles.map((h) => `@${h}`).join(', ') : 'the agents';
  work.threads.addItem(convId, {
    kind: 'voice',
    text: f?.before?.exists ? `Restored ${f.rel} to how it was before ${who} changed it` : `Removed ${f?.rel}, which ${who} created`,
  });
  return f;
}
