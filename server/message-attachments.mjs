// The attachments a message you send carries (POST /api/threads/:id/messages; runtime.mjs’s sendMessage), checked
// where they enter, before anything is posted or queued (#991). The page sends each upload’s name, type and size
// beside its fileId, but the upload’s record (s.files, written by POST /api/files) is what Postbox knows of it, under
// the name server/upload-name.mjs kept, so a file attachment takes all three from there: a right-to-left override the
// upload replaced can’t come back in the message, to its chip or to the agents it’s sent to. A record stored before
// that cleaning keeps its raw name, so it’s cleaned here as it’s read (#1067).
// Once sent, an attachment is read from disk where attachmentPath finds it: a stored upload, or a file in the project’s
// folder. attachmentPath moved here out of server/runtime.mjs, which keeps a method of that name that delegates here.

import { resolve, sep } from 'node:path';
import { httpError } from './helpers.mjs';
import { shownName, storedName, uploadName } from './upload-name.mjs';

/**
 * The attachments to store and deliver, each with only what Postbox knows of it. A file attachment whose upload is known
 * has that upload’s name (cleaned, if it was stored raw), type and size; one whose upload isn’t (removed while the
 * message was written) keeps only its kind, its fileId and its name, cleaned as an upload’s is, since the agent’s
 * prompt prints a type beside the name. A project file keeps only its kind and path, so no fileId sent beside it makes
 * its chip open another upload; the path is refused when it’s missing, or holds a character shownName replaces:
 * replacing one would point the agent at another file, or at none.
 * @param {any} rt @param {unknown} list  what the request sent
 * @returns {any[]}
 */
export function sentAttachments(rt, list) {
  if (!Array.isArray(list) || !list.every((a) => a !== null && typeof a === 'object')) throw httpError(422, 'attachments is a list of files, each an object.');
  return list.map((a) => (a.kind === 'project-file' ? projectFile(a) : upload(rt, a)));
}

/** @param {any} a */
function projectFile(a) {
  const path = a.path;
  // A project file is attached by its path: String() of a missing one was stored as “undefined” (#1067).
  if (typeof path !== 'string' || !path)
    throw httpError(422, 'A project file is attached by its path, and this one was sent without a path. Attach it again from the project’s files.');
  const shown = shownName(path);
  if (shown !== path)
    throw httpError(422, `“${shown}” can’t be attached: its name holds a control or invisible character, such as a bidi control. Rename it first.`);
  return { kind: 'project-file', path };
}

/** @param {any} rt @param {any} a */
function upload(rt, a) {
  const files = rt.s.files;
  if (Object.hasOwn(files, a.fileId)) {
    const f = files[a.fileId];
    return { kind: 'file', fileId: f.id, name: storedName(f.name), type: f.type, size: f.size };
  }
  return { kind: 'file', fileId: a.fileId, name: uploadName(String(a.name ?? '')) };
}

/** Where an attachment can be read on disk: a stored upload, or a file in the project’s folder. */
export function attachmentPath(rt, threadId, a) {
  if (a?.kind === 'file' && a.fileId) {
    const f = rt.s.files?.[a.fileId];
    return f?.sha256 && rt.blobs ? rt.blobs.pathOf(f.sha256) : null;
  }
  if (a?.kind === 'project-file' && a.path) {
    const folder = rt.s.projects[rt.s.threads[threadId]?.projectId]?.folder;
    if (!folder) return null;
    const full = resolve(folder, String(a.path).replace(/^\/+/, ''));
    return full === resolve(folder) || full.startsWith(resolve(folder) + sep) ? full : null;
  }
  return null;
}
