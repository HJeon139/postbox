// The work ledger’s answers to the page (#132): what a conversation’s agents changed, ran and published, read by the
// Work view, and the file it puts back. A conversation is the one a thread belongs to: its side and topic threads
// count toward it. Moved out of server/runtime.mjs; Runtime keeps a method of each name that delegates here.

import { httpError } from './helpers.mjs';

/** An error the ledger raised with a status, as the API answers it. */
const asHttp = (e) => {
  throw e?.status ? httpError(e.status, e.message) : e;
};

function workConversation(rt, threadId) {
  const t = rt.thread(threadId);
  if (t.kind === 'side' || t.kind === 'topic') throw httpError(404, 'Open the conversation this thread belongs to: its work is there.');
  return t.id;
}
/** Where each changed file and commit stands in git now (read-only). */
export function workGit(rt, threadId) {
  return rt.ledger.gitState(workConversation(rt, threadId));
}
/** @param {string} threadId @param {string} fileId @param {string|null} [changeId] */
export function workDiff(rt, threadId, fileId, changeId = null) {
  return rt.ledger.fileDiff(workConversation(rt, threadId), fileId, changeId).catch(asHttp);
}
export function workOutput(rt, threadId, entryId) {
  return rt.ledger.output(workConversation(rt, threadId), entryId).catch(asHttp);
}
/**
 * Puts a file back as it was before the agents first changed it (or removes one they created), and says so in the
 * conversation, so its agents read it on their next turn.
 */
export async function restoreWork(rt, threadId, fileId) {
  const convId = workConversation(rt, threadId);
  const f = await rt.ledger.restore(convId, fileId).catch(asHttp);
  const who = f?.handles?.length ? f.handles.map((h) => `@${h}`).join(', ') : 'the agents';
  rt.addItem(convId, {
    kind: 'voice',
    text: f?.before?.exists ? `Restored ${f.rel} to how it was before ${who} changed it` : `Removed ${f?.rel}, which ${who} created`,
  });
  return f;
}
