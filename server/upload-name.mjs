// An uploaded file’s name (POST /api/files, its x-filename header), as its attachment chip and the agents it’s sent to
// show it (#991). The file is the person’s, and its name is only shown, so a character that would hide or reorder the
// name is replaced with “_”, as \ and / are, rather than the upload refused over it.

import { hasControl, hiddenInFolder } from '../shared/invisible.mjs';
import { partEnd } from '../shared/text-parts.mjs';

/** The longest name kept, in UTF-16 code units. */
const NAME_MAX = 200;

/**
 * The name to keep for an upload: each \, /, control character, lone surrogate or character a project’s folder refuses
 * as hidden (shared/invisible.mjs, so ZWNJ and ZWJ stay, joining letters and emoji) is “_”, and it’s cut at NAME_MAX,
 * never between the halves of a surrogate pair. An empty name is “file”.
 * @param {string} sent  the header, decoded
 * @returns {string}
 */
export function uploadName(sent) {
  const shown = Array.from(sent, (c) => (c === '\\' || c === '/' || hasControl(c) || hiddenInFolder(c) ? '_' : c)).join('');
  return shown.slice(0, partEnd(shown, NAME_MAX)) || 'file';
}
