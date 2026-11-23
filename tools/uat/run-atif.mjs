// A UAT run’s ATIF trajectories (tools/atif-export.mjs), written to its `atif/` folder once the run’s own record is:
// its report, the verifier’s verdicts and run.json come first, so an export that fails can’t lose what the run cost
// (#1529). A failure is logged and left in atif/export-error.txt, with the command that writes them again.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readRecording, writeTrajectories } from '../atif-export.mjs';

/**
 * Writes the run’s trajectories from what it recorded: its saved history (writeHistory) and prompts.jsonl in its data
 * folder, as `node tools/atif-export.mjs <run>` reads them. Never throws.
 * @param {string} dir  the run’s folder @param {(line: string) => void} log @returns {string[]} the files written
 */
export function exportTrajectories(dir, log) {
  const out = join(dir, 'atif');
  try {
    const files = writeTrajectories(out, readRecording(dir));
    log(`ATIF: ${files.length} trajectories in ${relative(process.cwd(), out) || out}.`);
    return files;
  } catch (e) {
    const again = `node tools/atif-export.mjs ${dir} --out ${out}`;
    const said = `The run’s ATIF export failed: ${e?.message ?? e}. Its report and findings are written; to try again, run ${again}`;
    log(said);
    try {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'export-error.txt'), `${said}\n\n${e?.stack ?? ''}\n`);
    } catch {}
    return [];
  }
}
