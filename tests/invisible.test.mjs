// #1049: shared/invisible.mjs’s INVISIBLE takes in every default-ignorable code point and the line and paragraph
// separators, so each place that refuses, replaces or marks a character that shows as nothing does it for these too:
// an asset’s name, a folder here, a path on a host, an upload’s name, a project file attached to a message, a hook’s
// text in the Permissions panel and a refused folder shown in a message. The wider set also holds ZWNJ, ZWJ and VS16,
// and each caller keeps the exceptions it had: a folder and a host path take ZWNJ and ZWJ, an upload’s name and a
// project file keep all three, and an asset’s name, a hook’s text and a refused folder’s message take none.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { nameProblem } from '../server/assets.mjs';
import { fullPath, sessionFolder } from '../server/folder-path.mjs';
import { readHookFile } from '../server/permission-hooks.mjs';
import { hidesName, uploadName } from '../server/upload-name.mjs';
import { checkHostPath } from '../shared/remote-settings.mjs';
import { tempDir } from './temp-dirs.mjs';

// One example, or the two ends, of each class INVISIBLE didn’t hold before #1049.
const NEW = [
  '\u2028', // line separator (Zl)
  '\u2029', // paragraph separator (Zp)
  '\u180b', // Mongolian free variation selector one
  '\u180f', // Mongolian free variation selector four
  '\u{e0100}', // variation selector 17
  '\u{e01ef}', // variation selector 256
  '\u17b4', // Khmer vowel inherent AQ
  '\u17b5', // Khmer vowel inherent AA
  '\ufff0', // unassigned, in the specials block
  '\ufff8', // unassigned, in the specials block
];
const ZWNJ = '\u200c';
const ZWJ = '\u200d';
const VS16 = '\ufe0f';
// A format character that isn’t default-ignorable: Cf alone takes it in.
const ANNOTATION_ANCHOR = '\ufff9';

/** A character’s code points, as U+XXXX, for an assertion’s message. @param {string} c */
const name = (c) => [...c].map((x) => `U+${/** @type {number} */ (x.codePointAt(0)).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

/** What a folder with a character that hides or reorders text hears. */
const FOLDER_HIDDEN = 'A folder’s path can’t contain invisible characters, such as a zero-width space or a bidi control, or a lone surrogate.';
/** Whether fullPath refuses a folder as hidden. @param {string} folder */
const folderRefused = (folder) => {
  try {
    fullPath(folder);
    return false;
  } catch (e) {
    assert.equal(e.why, FOLDER_HIDDEN, name(folder));
    return true;
  }
};
/** Whether checkHostPath refuses a path as hidden. @param {string} path */
const hostRefused = (path) => {
  const r = checkHostPath(path, 'folder');
  if (r.ok) return false;
  assert.equal(r.error, `folder ${FOLDER_HIDDEN.slice('A folder’s path '.length)}`, name(path));
  return true;
};
/** A hook’s matcher and command as the Permissions panel gets them. @param {string} mark */
async function hookText(mark) {
  const file = join(tempDir('pb-invisible-'), 'settings.json');
  const hooks = [{ matcher: `Ba${mark}sh`, hooks: [{ type: 'command', command: `rm -rf ~${mark}/tmp/x` }] }];
  await writeFile(file, JSON.stringify({ hooks: { PreToolUse: hooks } }));
  const [hook] = (await readHookFile(file)).hooks;
  return [hook.matcher, hook.text];
}
/** The escape a refused folder’s message shows a character as. @param {string} c */
const escaped = (c) => {
  const code = /** @type {number} */ (c.codePointAt(0)).toString(16);
  return code.length > 4 ? `\\u{${code}}` : `\\u${code.padStart(4, '0')}`;
};
/**
 * Whether a refused session folder’s message shows the character as its escape rather than as itself. The folder ends
 * in a right-to-left override, so it’s refused whether or not the character is.
 * @param {string} c
 */
const sessionShowsEscape = (c) => {
  try {
    sessionFolder(`/tmp/a${c}b/\u202e`);
  } catch (e) {
    const shown = e.message.includes(`"/tmp/a${escaped(c)}b/\\u202e"`);
    assert.equal(e.message.includes(c), !shown, name(c));
    return shown;
  }
  return assert.fail(`${name(c)}: the folder is refused`);
};

test('#1049 an asset’s name with a default-ignorable character or a line or paragraph separator is refused', () => {
  for (const c of NEW) assert.notEqual(nameProblem(`a${c}b.md`), null, name(c));
});

test('#1049 a folder with a default-ignorable character or a line or paragraph separator is refused as hidden', () => {
  for (const c of NEW) assert.equal(folderRefused(`/tmp/a${c}b`), true, name(c));
});

test('#1049 a path on a host with a default-ignorable character or a line or paragraph separator is refused as hidden', () => {
  for (const c of NEW) assert.equal(hostRefused(`/srv/a${c}b`), true, name(c));
});

test('#1049 an upload’s name has each default-ignorable character and line or paragraph separator as “_”', () => {
  for (const c of NEW) assert.equal(uploadName(`a${c}b.txt`), 'a_b.txt', name(c));
});

test('#1049 a project file whose path holds a default-ignorable character or a separator is refused when attached', () => {
  for (const c of NEW) assert.equal(hidesName(c), true, name(c));
});

test('#1049 a hook’s text shows each default-ignorable character as a replacement mark, and a separator as a space', async () => {
  for (const c of NEW) {
    const mark = c === '\u2028' || c === '\u2029' ? ' ' : '\ufffd';
    assert.deepEqual(await hookText(c), [`Ba${mark}sh`, `rm -rf ~${mark}/tmp/x`], name(c));
  }
});

test('#1049 a refused session folder’s message shows each default-ignorable character and separator as its escape', () => {
  for (const c of NEW) assert.equal(sessionShowsEscape(c), true, name(c));
});

test('#1049 ZWNJ, ZWJ and VS16 are taken exactly where they were, and a format character that isn’t default-ignorable nowhere', async () => {
  const joined = { [ZWNJ]: 'ZWNJ', [ZWJ]: 'ZWJ', [VS16]: 'VS16', [ANNOTATION_ANCHOR]: 'U+FFF9' };
  const taken = {};
  for (const [c, what] of Object.entries(joined)) {
    const [matcher] = await hookText(c);
    taken[what] = {
      asset: nameProblem(`a${c}b.md`) === null,
      folder: !folderRefused(`/tmp/a${c}b`),
      hostPath: !hostRefused(`/srv/a${c}b`),
      upload: uploadName(`a${c}b.txt`) === `a${c}b.txt`,
      projectFile: !hidesName(c),
      hook: matcher === `Ba${c}sh`,
      refusedFolderShown: !sessionShowsEscape(c),
    };
  }
  const only = (folder, upload) => ({ asset: false, folder, hostPath: folder, upload, projectFile: upload, hook: false, refusedFolderShown: false });
  assert.deepEqual(taken, { ZWNJ: only(true, true), ZWJ: only(true, true), VS16: only(false, true), 'U+FFF9': only(false, false) });
});
