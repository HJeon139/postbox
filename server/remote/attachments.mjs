// A message’s attachments on a turn that runs on a remote host (#120). The agent there can’t read a path on this
// computer, so each file goes to the host with the turn’s start (start.attachments), and the message points the agent
// at its copy in the host turn’s folder, `attachments/<name>` (server/adapters/remote-turn.mjs’s attachmentPaths). A
// second host turn in the same deliver carries them again, to its own folder. The runtime reads them here before
// anything is asked of the host (server/remote/turns-start.mjs’s prepare), so a message over one of the protocol’s
// limits (REMOTE_LIMITS.attachments, attachmentBytes, attachmentsBytes) is refused before the turn starts, saying
// which: a file is never dropped on the way.

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { REMOTE_LIMITS } from '../../shared/remote-protocol.mjs';

/**
 * One attachment as a remote turn carries it: `of` is the message’s attachment object itself, which formatMessage’s
 * pathOf is given; `name` is the plain name it has on the host; `base64` its bytes.
 * @typedef {{ of: any, name: string, base64: string }} RemoteAttachment
 */

const MiB = 1024 * 1024;
/** A size such as 3 MB or 3.5 MB, rounded up, so a file just over a limit never reads as the limit. @param {number} n */
const mb = (n) => `${Math.ceil((n / MiB) * 10) / 10} MB`;

/** What the person called an attachment: an upload’s name, or a project file’s path. @param {any} a */
const shownName = (a) => String((a?.kind === 'project-file' ? a.path : a?.name) ?? 'file');

/**
 * The plain name an attachment has on the host (shared/remote-protocol-checks.mjs’s FILE_RE, at most 64 characters):
 * its number in the message, then its own name with anything but letters, digits, . _ and - made _, keeping its
 * extension when it has to be cut. The number keeps two files of the same name apart.
 * @param {any} a @param {number} i  its place among the files carried
 */
export function hostName(a, i) {
  const prefix = `${i + 1}-`;
  const clean =
    basename(shownName(a))
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/\.{2,}/g, '.') || 'file';
  const ext = /\.[A-Za-z0-9]{1,12}$/.exec(clean)?.[0] ?? '';
  const stem = clean.slice(0, clean.length - ext.length).slice(0, 64 - prefix.length - ext.length);
  return `${prefix}${stem}${ext}`.replace(/\.{2,}/g, '.');
}

/** Why a file is over the one-file limit. @param {any} a @param {number} n  its bytes */
const tooBig = (a, n) =>
  new Error(
    `“${shownName(a)}” is ${mb(n)}, and a file sent to an agent on a host can be at most ${mb(REMOTE_LIMITS.attachmentBytes)}. Send a smaller file, or copy it to the host and give the agent its path there.`,
  );

/** One attachment’s bytes; one over the one-file limit is refused before it’s read. @param {any} a @param {string} path */
async function readOne(a, path) {
  /** @param {Error} e @returns {never} */
  const unread = (e) => {
    throw new Error(`Couldn’t read “${shownName(a)}” to send it to the host: ${e.message}`);
  };
  const { size } = await stat(path).catch(unread);
  if (size > REMOTE_LIMITS.attachmentBytes) throw tooBig(a, size);
  const bytes = await readFile(path).catch(unread);
  // A file that grew since stat is measured again.
  if (bytes.length > REMOTE_LIMITS.attachmentBytes) throw tooBig(a, bytes.length);
  return bytes;
}

/**
 * The attachments a remote turn carries, read from where they are on this computer (ctx.pathOf: the blob store, or the
 * project’s folder). One with no path here has nothing to carry, and the message names it without one, as on this
 * computer. Throws, naming the limit, for a message over one of them.
 * @param {any} message @param {(a: any) => string | null} [pathOf]
 * @returns {Promise<RemoteAttachment[]>}
 */
export async function carryAttachments(message, pathOf = () => null) {
  const found = (Array.isArray(message?.attachments) ? message.attachments : []).map((a) => ({ a, path: pathOf(a) })).filter((x) => x.path);
  if (found.length > REMOTE_LIMITS.attachments)
    throw new Error(
      `This message has ${found.length} files attached, and one message to an agent on a host can carry at most ${REMOTE_LIMITS.attachments}. Send them in more than one message.`,
    );
  /** @type {RemoteAttachment[]} */
  const out = [];
  let total = 0;
  for (const [i, { a, path }] of found.entries()) {
    const bytes = await readOne(a, /** @type {string} */ (path));
    total += bytes.length;
    if (total > REMOTE_LIMITS.attachmentsBytes)
      throw new Error(
        `The files attached to this message come to over ${mb(REMOTE_LIMITS.attachmentsBytes)}, the most one message to an agent on a host can carry. Send them in more than one message, or copy them to the host and give the agent their paths there.`,
      );
    out.push({ of: a, name: hostName(a, i), base64: bytes.toString('base64') });
  }
  return out;
}
