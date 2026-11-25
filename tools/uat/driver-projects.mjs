// The UAT runner’s new project steps: Settings, its Projects tab, New project, the name and folder typed, Create project, and
// Settings closed, as a person would. Kept out of tools/uat/driver.mjs, to keep that file to its size; it uses the
// driver’s clickAt, typeInto and press.

import { sleep } from '../browser.mjs';
import { byText } from './selectors.mjs';

/**
 * @param {{ clickAt: Function, typeInto: Function, press: Function }} kit  the driver’s own
 * @param {string} name @param {string} folder
 */
export async function newProject({ clickAt, typeInto, press }, name, folder) {
  await clickAt(`document.querySelector('[aria-label="Settings"]')`, 'the Settings button');
  await clickAt(byText('document.querySelector(".dialog")', '[role=tab], button', 'Projects'), 'the Projects tab');
  // The form is behind the list’s + (#1735).
  await clickAt(`document.getElementById('pj-new')`, 'New project');
  await typeInto(`document.getElementById('pj-n')`, name, 'the project name field');
  await typeInto(`document.getElementById('pj-f')`, folder, 'the project folder field');
  await clickAt(byText('document.querySelector(".dialog")', 'button', 'Create project'), 'Create project');
  await sleep(400);
  await press('Escape');
}
