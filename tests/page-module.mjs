// Loads a page module (app/js) in Node. The browser serves shared code at /shared/, which Node can’t resolve, so the
// module and the page modules it imports are copied to a temp folder with their /shared/ imports pointing at the files,
// as tests/item-ranges.test.mjs does.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from './temp-dirs.mjs';

const shared = pathToFileURL(join(import.meta.dirname, '../shared/')).href;

/**
 * The exports of app/js/<entry>, with each of `imports` (other app/js files it reaches) copied beside it.
 * @param {string} entry @param {string[]} [imports]
 */
export async function pageModule(entry, imports = []) {
  const dir = tempDir('pb-page-module-');
  for (const name of [entry, ...imports]) {
    const src = readFileSync(new URL(`../app/js/${name}`, import.meta.url), 'utf8').replaceAll("'/shared/", `'${shared}`);
    writeFileSync(join(dir, name), src);
  }
  return import(pathToFileURL(join(dir, entry)).href);
}
