// The attachments a message you send carries (POST /api/threads/:id/messages; runtime.mjs’s sendMessage), checked
// where they enter, before anything is posted or queued (#991). The page sends each upload’s name, type and size
// beside its fileId, but the upload’s record (s.files, written by POST /api/files) is what Postbox knows of it, under
// the name server/upload-name.mjs kept, so a file attachment takes all three from there: a right-to-left override the
// upload replaced can’t come back in the message, to its chip or to the agents it’s sent to.

import { httpError } from './helpers.mjs';
import { hidesName, uploadName } from './upload-name.mjs';

/**
 * The attachments to store and deliver. A file attachment whose upload is known has that upload’s name, type and size;
 * one whose upload isn’t is kept, as before, with its name cleaned as an upload’s is. A project file is attached by its
 * path, which is refused when it holds a character that hidesName: replacing one would point the agent at another file,
 * or at none.
 * @param {any} rt @param {unknown} list  what the request sent
 * @returns {any[]}
 */
export function sentAttachments(rt, list) {
  if (!Array.isArray(list) || !list.every((a) => a !== null && typeof a === 'object')) throw httpError(422, 'attachments is a list of files, each an object.');
  return list.map((a) => (a.kind === 'project-file' ? projectFile(a) : upload(rt, a)));
}

/** @param {any} a */
function projectFile(a) {
  const path = String(a.path);
  const shown = Array.from(path, (c) => (hidesName(c) ? '_' : c)).join('');
  if (shown !== path)
    throw httpError(422, `“${shown}” can’t be attached: its name holds a control or invisible character, such as a bidi control. Rename it first.`);
  return a;
}

/** @param {any} rt @param {any} a */
function upload(rt, a) {
  const files = rt.s.files;
  if (Object.hasOwn(files, a.fileId)) {
    const f = files[a.fileId];
    return { kind: 'file', fileId: f.id, name: f.name, type: f.type, size: f.size };
  }
  return { ...a, name: uploadName(String(a.name ?? '')) };
}
