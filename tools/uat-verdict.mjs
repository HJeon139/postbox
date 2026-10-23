// Records, or overrides, the verdict on one finding of a UAT run, in its findings.json, with who set it and when. A
// person’s or a reviewer’s verdict wins over the verifier’s (tools/uat/verdicts.mjs). The run’s report shows it the
// next time the run is rechecked; the stats (tools/uat-stats.mjs) read it at once.
//
//   node tools/uat-verdict.mjs <run> --list
//   node tools/uat-verdict.mjs <run> <finding key or index> <verdict> [note] [--issue N] [--by person|reviewer|verifier]
//
// <run> is a run folder, or its name in the runs folder (uat-runs/ in the main checkout, or POSTBOX_UAT_RUNS).
// Verdicts: confirmed, duplicate (with --issue), harness, agent, by-design, not-reproduced, measurement.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runsRoot, writeJsonAtomic } from './uat/runs.mjs';
import { findFinding, findingKey, normalVerdict, setVerdict, VERDICTS } from './uat/verdicts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The CLI, with its output and files injectable for tests.
 * @param {string[]} argv  @param {{ root?: string, now?: () => string, print?: (s: string) => void }} [io]
 * @returns {number}  the exit code
 */
export function verdictCli(argv, { root = ROOT, now = () => new Date().toISOString(), print = console.log } = {}) {
  const { values: opt, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { issue: { type: 'string' }, by: { type: 'string', default: 'reviewer' }, list: { type: 'boolean', default: false } },
  });
  const [run, ref, verdict, ...note] = positionals;
  if (!run) {
    print('Usage: node tools/uat-verdict.mjs <run> <finding key or index> <verdict> [note] [--issue N] [--by person|reviewer|verifier]');
    return 2;
  }
  const dir = existsSync(run) ? resolve(run) : join(runsRoot({ root }), run);
  const file = join(dir, 'findings.json');
  if (!existsSync(file)) {
    print(`No findings.json in ${dir}.`);
    return 1;
  }
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const findings = Array.isArray(saved.findings) ? saved.findings : [];
  if (opt.list || !ref) {
    findings.forEach((f, i) => {
      print(`${i}\t${findingKey(f)}\t${f.verdict ?? 'not reviewed'}${f.verdictBy ? ` (${f.verdictBy})` : ''}\t${f.title}`);
    });
    return 0;
  }
  if (!['person', 'reviewer', 'verifier'].includes(String(opt.by))) {
    print(`--by is person, reviewer or verifier, not “${opt.by}”.`);
    return 2;
  }
  const v = normalVerdict(verdict);
  if (!v) {
    print(
      `“${verdict ?? ''}” isn’t a verdict. Use one of:\n${Object.entries(VERDICTS)
        .map(([k, d]) => `  ${k}: ${d}`)
        .join('\n')}`,
    );
    return 2;
  }
  const issue = opt.issue === undefined ? null : Number(String(opt.issue).replace(/^#/, ''));
  if (opt.issue !== undefined && !(Number.isInteger(issue) && /** @type {number} */ (issue) > 0)) {
    print(`--issue takes an issue number, not “${opt.issue}”.`);
    return 2;
  }
  let found;
  try {
    found = findFinding(findings, ref);
  } catch (e) {
    print(e.message);
    return 1;
  }
  if (v === 'duplicate' && !issue && !found.finding.duplicateOf) {
    print('A duplicate names the open issue it duplicates: add --issue N.');
    return 2;
  }
  const took = setVerdict(found.finding, { verdict: v, by: String(opt.by), note: note.join(' ') || null, issue, at: now() });
  if (!took) {
    print(`Finding ${found.index} keeps its ${found.finding.verdictBy}’s verdict (${found.finding.verdict}): a verifier’s doesn’t override it.`);
    return 1;
  }
  writeJsonAtomic(file, { ...saved, findings });
  print(`Finding ${found.index} (${findingKey(found.finding)}): ${v}${issue ? ` of #${issue}` : ''}, by the ${opt.by}.`);
  return 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = verdictCli(process.argv.slice(2));
