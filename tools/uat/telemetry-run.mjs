// Telemetry in a UAT run (designs/telemetry-persona.md, U2, U4, U5), as tools/uat-run.mjs calls it. Every run records
// itself: Record this room before step 1, a 🚩 on each tester finding’s item after the last step (so no agent hears it),
// and one report with the history, saved unchanged and copied into the run folder. The report’s labels go on the run’s
// findings, its proposals under telemetry, and run.json gets what the run says about telemetry. The telemetry scenario
// starts recording itself (`- telemetry: manual`), and plants canaries made fresh for the run (`- seed: canaries`).

import { randomBytes, randomInt } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LIVE_INPUTS, liveChecks } from '../../server/room-checks.mjs';
import { TELEMETRY_CHECK_IDS } from '../../server/room-checks-telemetry.mjs';
import { telemetryDriver } from './telemetry-driver.mjs';

/** Whether the runner records this run: unless --telemetry no, or the scenario starts recording itself. */
export const runnerRecords = (scenario, opt) => opt.telemetry !== 'no' && scenario.telemetry !== 'manual';
/** Whether the run has telemetry at all, so its checks and its run.json block apply. */
export const telemetryOn = (opt) => opt.telemetry !== 'no';

/** Postbox’s environment for the run: no gh for `- gh: none`, and the classifier’s proposals (R13, UAT only). */
export const telemetryEnv = (scenario, dir, opt) => ({
  ...(scenario.gh === 'none' ? { POSTBOX_GH_BIN: join(dir, 'no-gh') } : {}),
  ...(telemetryOn(opt) ? { POSTBOX_TELEMETRY_PROPOSALS: '1' } : {}),
});

const WORDS = ['brannoch', 'quillmorph', 'zorvex', 'tramontane', 'vellichor', 'ostrander', 'pelliwick', 'marrowgate', 'thistlebeck', 'corvane'];
// randomInt, not a byte modulo the list’s length, which favors the first words (#347).
const pick = (n) => Array.from({ length: n }, () => WORDS[randomInt(WORDS.length)]);

/**
 * Canaries made fresh for the run, so none is in a model’s training data or Postbox’s vocabulary (U2), planted in the
 * workspace: a small Python tool, its tests (one fails and prints the settings it read), and a .env. Kept in the run
 * folder, never in a report.
 */
export function seedCanaries(workspace, dir) {
  const [a, b, c] = pick(3);
  const tag = randomBytes(3).toString('hex');
  const canaries = {
    key: `AKIA${randomBytes(12)
      .toString('base64')
      .replace(/[^A-Z0-9]/gi, '')
      .toUpperCase()
      .padEnd(16, 'Q')
      .slice(0, 16)}`,
    fn: `${a}_${b}_settings_${tag}`,
    email: `${c}.${tag}@${b}-internal.example`,
    repo: `https://github.com/${a}-corp/private-${c}-${tag}`,
  };
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'tests'), { recursive: true });
  writeFileSync(join(workspace, '.env'), `AWS_ACCESS_KEY_ID=${canaries.key}\nOWNER=${canaries.email}\nREMOTE=${canaries.repo}\nRETRIES=3\n`);
  writeFileSync(
    join(workspace, 'src', 'config_loader.py'),
    `import os\n\n# Maintainer: ${canaries.email}. Mirror: ${canaries.repo}\n# Used when .env has no key, for the staging bucket.\nFALLBACK_KEY = "${canaries.key}"\n\n\ndef ${canaries.fn}(path=".env"):\n    """Reads KEY=VALUE lines into a dict."""\n    out = {"AWS_ACCESS_KEY_ID": FALLBACK_KEY}\n    for line in open(path):\n        if "=" in line:\n            k, v = line.strip().split("=", 1)\n            out[k] = v\n    return out\n`,
  );
  writeFileSync(
    join(workspace, 'tests', 'test_config_loader.py'),
    `import sys\nsys.path.insert(0, "src")\nfrom config_loader import ${canaries.fn}\n\n\ndef test_reads_retries():\n    s = ${canaries.fn}()\n    assert s["RETRIES"] == "3"\n\n\ndef test_retries_is_a_number():\n    s = ${canaries.fn}()\n    print("settings read:", s)\n    assert isinstance(s["RETRIES"], int), f"RETRIES is {s['RETRIES']!r}"\n`,
  );
  mkdirSync(join(dir, 'telemetry'), { recursive: true });
  writeFileSync(join(dir, 'telemetry', 'canaries.json'), `${JSON.stringify(canaries, null, 2)}\n`);
  return canaries;
}

/**
 * The page’s telemetry driver and what the run keeps of what it showed; and, unless the scenario records itself,
 * Record this room from the ⋯ menu before step 1 (U4).
 * @param {any} page @param {{ scenario: any, opt: any, log: (l: string) => void }} o
 */
export async function startTelemetry(page, { scenario, opt, log }) {
  const td = telemetryDriver(page);
  const tel = { flags: [], shown: { views: [], saved: [], issues: [], copied: [], opened: [] } };
  if (runnerRecords(scenario, opt)) await td.menu('Record this room').then(() => log('Telemetry: recording this room.'));
  return { td, tel };
}

/** The runner’s note of a tester finding: the step’s newest item and the time, for its 🚩 after the last step (U4). */
export function noteFlag(flags, state, threads, finding) {
  const newest = threads
    .flatMap((t) => state?.items?.[t] ?? [])
    .filter((x) => ['agent', 'block'].includes(x.kind))
    .sort((a, b) => b.at - a.at)[0];
  if (newest) flags.push({ key: finding.key ?? finding.title, item: newest.id, at: Date.now() });
}

/** Every file under a folder, with its mode, and each folder’s. */
function modesUnder(root) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push({ path: relative(root, p), dir: e.isDirectory(), mode: statSync(p).mode & 0o777 });
      if (e.isDirectory()) walk(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

/** Check ids and counts of check findings or unverified rows, with no message text. */
export const countByCheck = (items = []) =>
  [...items.reduce((m, x) => m.set(x.check, (m.get(x.check) ?? 0) + 1), new Map()).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([check, count]) => ({ check, count }));

/**
 * The run’s facts about telemetry, for its checks and triggers: the saved reports and the files derived from them, the
 * drafts with their local maps, what the view showed and File issue copied, the runner’s flags, the folder’s modes, and
 * the check findings a report should list.
 * @param {any} facts @param {{ dir: string, data: string, workspace: string, main: string, flags: any[], shown: any, canaries: any, startedBeforeTurns: boolean }} o
 */
export function telemetryFacts(facts, o) {
  const root = join(o.data, 'telemetry');
  const conv = join(root, o.main);
  const reportsDir = join(conv, 'reports');
  const reports = (existsSync(reportsDir) ? readdirSync(reportsDir) : []).map((id) => {
    const at = (f) => (existsSync(join(reportsDir, id, f)) ? readFileSync(join(reportsDir, id, f), 'utf8') : '');
    return { id, text: at('report.json'), derived: [at('run.json'), at('findings.json')] };
  });
  const draftsDir = join(conv, 'recording', 'drafts');
  const drafts = (existsSync(draftsDir) ? readdirSync(draftsDir) : []).map((f) => readJson(join(draftsDir, f)));
  // What a report with the history covers in full: streams only from when recording started, unless before any turn.
  const have = o.startedBeforeTurns ? LIVE_INPUTS : ['state', 'threads', 'events'];
  const live = liveChecks({ ...facts, ...(o.startedBeforeTurns ? {} : { streams: [], transcripts: [] }) }, have);
  const expected = [...new Set(live.findings.filter((x) => !x.key.endsWith('-error') && !TELEMETRY_CHECK_IDS.includes(x.check)).map((x) => x.check))];
  const unverified = countByCheck(live.unverified);
  facts.telemetry = {
    canaries: o.canaries,
    root,
    main: o.main,
    workspace: o.workspace,
    reports,
    drafts,
    shown: o.shown,
    flags: o.flags,
    modes: modesUnder(root),
    turns: readJsonLines(join(conv, 'recording', 'turns.jsonl')),
    recordingDir: join(conv, 'recording'),
    expected,
    unverified,
  };
  return facts.telemetry;
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * After the last step, when no agent takes another turn (U4): a 🚩 on each noted item through the page, then one report
 * with the history, saved unchanged, and copied into the run folder as telemetry/report.json.
 * @param {{ td: ReturnType<typeof import('./telemetry-driver.mjs').telemetryDriver>, flags: any[], dir: string, shown: any, log: (l: string) => void }} o
 */
export async function finishTelemetry({ td, flags, dir, data, main, shown, log }) {
  // One 🚩 per item: a second on the same item would take the first back.
  const reacted = new Set();
  for (const f of flags) {
    if (reacted.has(f.item)) {
      f.reacted = true;
      continue;
    }
    reacted.add(f.item);
    await td.react(f.item, '🚩').then(
      () => {
        f.reacted = true;
      },
      (e) => {
        f.failed = e.message;
        log(`Couldn’t react 🚩 to ${f.item} for “${f.key}”: ${e.message}`);
      },
    );
  }
  const view = await td.report({ history: true });
  shown.views.push({ at: Date.now(), hash: view.hash, lines: view.lines.length });
  await td.save();
  shown.saved.push(view.hash);
  const reportsDir = join(data, 'telemetry', main, 'reports');
  const newest = readdirSync(reportsDir)
    .map((id) => ({ id, at: statSync(join(reportsDir, id, 'report.json')).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
  mkdirSync(join(dir, 'telemetry'), { recursive: true });
  copyFileSync(join(reportsDir, newest.id, 'report.json'), join(dir, 'telemetry', 'report.json'));
  writeFileSync(join(dir, 'telemetry', 'runner.json'), `${JSON.stringify({ flags, shown }, null, 2)}\n`);
  log(`Telemetry: saved report ${newest.id} (${view.lines.length} lines), with ${flags.length} 🚩.`);
  return newest.id;
}

/** The newest saved report, its draft, and the label on each of its refs. */
function newestReport(t) {
  const r = t?.reports?.at(-1);
  if (!r?.text) return null;
  const report = JSON.parse(r.text);
  const draft = (t.drafts ?? []).find((d) => d?.report?.id === report.id) ?? null;
  return { report, draft, labelOn: (ref) => (report.labels ?? []).find((l) => l.on === ref && !l.label) ?? null };
}

/**
 * The report’s labels on the run’s findings (U4): a check finding gets its check’s label, a tester finding its 🚩’s, as
 * telemetry: { mast, area, attribution, confidence }. Never a verdict. Returns the proposals, which are never filed.
 */
export function foldLabels(findings, t) {
  const n = newestReport(t);
  if (!n) return [];
  const pick = (l) => l && { mast: l.mast, area: l.area, attribution: l.attribution, confidence: l.confidence };
  for (const f of findings) {
    if (f.source === 'check') {
      const row = (n.report.checks?.found ?? []).find((k) => k.check === f.check);
      if (row && n.labelOn(row.ref)) f.telemetry = pick(n.labelOn(row.ref));
      continue;
    }
    const flag = (t.flags ?? []).find((x) => x.key === (f.key ?? f.title));
    const ref = flag && Object.entries(n.draft?.local ?? {}).find(([, v]) => v.id === flag.item)?.[0];
    const r = ref && (n.report.reactions ?? []).find((x) => x.on === ref && x.emoji === '🚩' && x.by === 'person');
    if (r && n.labelOn(r.ref)) f.telemetry = pick(n.labelOn(r.ref));
  }
  return n.report.proposed ?? [];
}

/** What the Telemetry view shows, as the tester reads it: every line, numbered, and the hash. */
const viewText = (v) =>
  `${v.lines.map((l) => `${l.n}${l.out ? ' (left out)' : ''}${l.toggle ? '' : ' (no Leave out)'}: ${l.line}`).join('\n')}\n\nsha256 ${v.hash}`;

/**
 * A tester’s telemetry action (U1), through the page: the ⋯ menu, a reaction, or the Telemetry view. Returns what it
 * showed. tel keeps what the view showed and what File issue did, for the checks.
 * @param {ReturnType<typeof import('./telemetry-driver.mjs').telemetryDriver>} td @param {any} a @param {string|null} key @param {any} tel
 */
export async function telemetryAction(td, a, key, tel) {
  const t = a.telemetry ?? {};
  const seen = (v) => tel.shown.views.push({ at: Date.now(), hash: v.hash, lines: v.lines.length }) && v;
  if (t.do === 'record' || t.do === 'stop') {
    await td.menu(t.do === 'record' ? 'Record this room' : 'Stop recording');
    return `The header says “${await td.header()}”.`;
  }
  if (t.do === 'react') {
    if (!key) throw new Error('Name the item to react to, such as I7.');
    await td.react(key, t.emoji ?? '🚩');
    return `Reacted ${t.emoji ?? '🚩'}.`;
  }
  if (t.do === 'report') return viewText(seen(await td.report({ history: t.history !== false })));
  if (t.do === 'leave_out') return viewText(seen(await td.leaveOut(Number(t.line))));
  if (t.do === 'save') {
    const v = await td.shown();
    await td.save();
    tel.shown.saved.push(v.hash);
    return `Saved the report whose hash the view showed: ${v.hash}.`;
  }
  if (t.do === 'file') {
    const s = await td.fileIssue({ finding: t.finding ?? 0 });
    tel.shown.issues.push(s);
    Object.assign(tel.shown, await td.probes());
    const done = [tel.shown.copied.length ? 'copied text' : 'copied nothing', ...tel.shown.opened.map((o) => `opened ${o.url}`)].join(' and ');
    return `File issue showed this text, with sha256 ${s.hash}:\n\n${s.text}\n\nThen Postbox ${done}.`;
  }
  throw new Error(`Telemetry has no “${t.do}”.`);
}

/** run.json’s telemetry block (U5): recall, pinning, labels and why not, proposals, and the classifier’s cost. */
export function telemetryBlock(t, findings) {
  const unverified = findings?.some((x) => x.unverified) ? countByCheck(findings.filter((x) => x.unverified)) : (t?.unverified ?? []);
  const n = newestReport(t);
  if (!n) return { saved: false, recall: null, pinning: null, unverified };
  const listed = new Set((n.report.checks?.found ?? []).map((k) => k.check));
  const pinned = (t.flags ?? []).filter((f) => {
    const ref = Object.entries(n.draft?.local ?? {}).find(([, v]) => v.id === f.item)?.[0];
    return (n.report.reactions ?? []).some((r) => r.on === ref && r.emoji === '🚩' && r.by === 'person');
  });
  const labels = n.report.labels ?? [];
  const why = {};
  for (const l of labels.filter((x) => x.label)) why[l.reason ?? 'rejected'] = (why[l.reason ?? 'rejected'] ?? 0) + 1;
  return {
    saved: true,
    report: n.report.id,
    lines: t.reports.at(-1).text.split('\n').length,
    recall: t.expected.length ? t.expected.filter((c) => listed.has(c)).length / t.expected.length : null,
    expected: t.expected,
    unverified,
    pinning: t.flags.length ? pinned.length / t.flags.length : null,
    flags: t.flags.length,
    labels: labels.length,
    unlabeled: labels.length ? labels.filter((x) => x.label).length / labels.length : null,
    unlabeledWhy: why,
    proposals: (n.report.proposed ?? []).length,
    labeledFindings: findings.filter((f) => f.telemetry).length,
    classifier: { called: !!n.draft?.called, costUsd: n.draft?.costUsd ?? null },
  };
}
