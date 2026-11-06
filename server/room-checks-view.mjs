// The transcript’s view (#531, designs/508/b1-view-state.md): what you were reading moved, or the view’s mode changed,
// when nothing you or the runner did came between. It reads the view probe the UAT records each step
// (tools/uat/view-probe.mjs, facts.probes.views) and the inputs the run made (facts.probes.inputs), and should never
// fire. A run with no inputs recorded can’t tell a scroll from a move, so the check says nothing of it.

/** A move of more than this, in px, is one; a published offset is rounded to 0.1 px. */
const MOVED_PX = 1;
/** Following, the view may sit this far above the end, as app/js/view-state.mjs’s atEnd allows. */
const END_PX = 2;

const px = (n) => `${Math.round(n * 10) / 10} px`;
/** One transcript in one page load: its samples are compared only with each other. */
const pageKey = (s) => `${s.where}\u0000${s.thread}\u0000${s.origin}`;

/** Whether an input's time falls in [from, to], by binary search of the sorted times: O(log inputs). */
function inputBetween(/** @type {number[]} */ times, from, to) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < times.length && times[lo] <= to;
}
/** A sample the check may read: one whose two reads a frame apart agreed. A runner's move is an input (B1b-b), not a sample. */
const usable = (s) => s.settled === true;
const where = (s) => (s.where === 'panel' ? 'the side panel' : 'the conversation');

/** One sample: the offset the page published for its anchor isn’t where the anchor is (a stale publish). */
function stale(s) {
  if (s.mode !== 'reading' || typeof s.actual !== 'number' || typeof s.expected !== 'number') return null;
  if (Math.abs(s.actual - s.expected) <= MOVED_PX) return null;
  return {
    key: `view-moved:stale:${s.where}:${s.thread}:${s.step}`,
    title: 'The view’s published place isn’t where its anchor is',
    evidence: `At step ${s.step}, ${where(s)} said ${s.anchorId} was ${px(s.expected)} down the view; it was at ${px(s.actual)}.`,
  };
}

/**
 * Two samples of one transcript and page load in a row, with no input between: the mode changed, the view following
 * the end drifted from it, or the earlier anchor is somewhere else now. That anchor is measured again in the later read
 * (prev), by its key, so a jump that takes a new anchor still shows where the old one went. Returns a finding, 'skipped'
 * when the earlier anchor isn’t mounted any more, or null.
 */
function moved(a, b) {
  const pair = `${b.where}:${b.thread}:${a.step}-${b.step}`;
  if (a.mode !== b.mode)
    return {
      key: `view-moved:mode:${pair}`,
      title: 'The view changed between following and reading without a scroll',
      evidence: `Between steps ${a.step} and ${b.step}, with no input between, ${where(b)} went from ${a.mode} to ${b.mode}.`,
    };
  if (b.mode === 'following')
    return b.gap > END_PX
      ? {
          key: `view-moved:drift:${pair}`,
          title: 'The view stopped following the newest message without a scroll',
          evidence: `At step ${b.step}, ${where(b)} was following, ${px(b.gap)} above the end, with no input since step ${a.step}.`,
        }
      : null;
  if (!b.prev || b.prev.anchorId !== a.anchorId || typeof a.actual !== 'number') return 'skipped';
  if (Math.abs(b.prev.actual - a.actual) <= MOVED_PX) return null;
  return {
    key: `view-moved:moved:${pair}`,
    title: 'What you were reading moved without a scroll',
    evidence: `Between steps ${a.step} and ${b.step}, with no input between, ${b.prev.anchorId} in ${where(b)} went from ${px(a.actual)} to ${px(b.prev.actual)} down the view.`,
  };
}

/** What the check says of a run whose probe ran but never read a view: a broken probe, not a quiet view. */
const NO_VIEWS = Object.freeze({
  key: 'view-moved:unverified:no-views',
  issue: null,
  title: 'view-moved checked nothing: the view probe read no transcript',
  evidence: 'The view probe ran each step but recorded no sample, so nothing about the view was seen.',
  verdict: 'measurement',
  note: 'Not a defect in the page: the probe failed or found no transcript.',
  unverified: { check: 'view-moved', thread: null },
});

/** What the check says of a run with views but no inputs: it checked nothing, which isn't a pass. */
const NO_INPUTS = Object.freeze({
  key: 'view-moved:unverified:no-inputs',
  issue: null,
  title: 'view-moved checked nothing: the run recorded no inputs',
  evidence:
    'The view probe sampled the transcript, but the run kept no record of its scrolls and clicks, so a move it made can’t be told from one the page made.',
  verdict: 'measurement',
  note: 'Not a defect: the run predates the input recorder (B1b-b).',
  unverified: { check: 'view-moved', thread: null },
});

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A row saying the check couldn’t vouch for one transcript, with why. */
function unverifiedRow(t, kind, title, evidence, note) {
  return {
    key: `view-moved:unverified:${kind}:${t.where}:${t.thread}`,
    issue: null,
    title,
    evidence,
    verdict: 'measurement',
    note,
    unverified: { check: 'view-moved', thread: t.thread },
  };
}

/** Why a transcript had no pair compared, from its tally: no settled sample, one, an input in every pair, or none in a row. */
function whyNoPair(t) {
  const counted = `${plural(t.samples, 'sample')}, ${t.settled} settled`;
  if (t.settled === 0) return `${counted}, so there was nothing to compare.`;
  if (t.settled === 1) return `${counted}, so there was no pair to compare.`;
  if (t.withInput > 0) {
    return `${counted}: all ${plural(t.withInput, 'pair')} of settled samples had an input between them, so only the within-sample rule (the published offset against the anchor) checked those steps.`;
  }
  return `${counted}, but no two in a row in one page load.`;
}

/** The rows a transcript’s tally gives: it compared no pair, or some pairs went unchecked. O(1). */
function tallyRows(t) {
  if (t.compared === 0) {
    const title = `view-moved checked no pair of steps in ${where(t)}`;
    return [unverifiedRow(t, 'no-pair', title, whyNoPair(t), 'Not a defect: no two settled samples came with no input between.')];
  }
  if (!t.skipped) return [];
  const title = `view-moved couldn’t check every step in ${where(t)}`;
  const evidence = `${t.skipped} of ${t.compared} pairs of steps with no input between went unchecked: the later step couldn’t measure the earlier step’s anchor (it had left the page, or the conversation changed between them), so where it went is unknown.`;
  return [unverifiedRow(t, 'skipped', title, evidence, 'Not a defect: an anchor that left the page can’t be measured.')];
}

/** What the check says of a run whose probe missed the view at some steps: those steps weren’t seen at all. */
const missedRow = (misses) => ({
  key: 'view-moved:unverified:misses',
  issue: null,
  title: 'view-moved didn’t see every step: the view probe missed some',
  evidence: `The view probe missed the view at ${plural(misses, 'step')}, so nothing about the view was seen there.`,
  verdict: 'measurement',
  note: 'Not a defect in the page: the probe found no transcript at those steps.',
  unverified: { check: 'view-moved', thread: null },
});

/** @param {{ probes?: { views?: any[], inputs?: { at: number }[], viewMisses?: number } }} f */
function viewMoved(f) {
  const views = f.probes?.views;
  const inputs = f.probes?.inputs;
  const misses = f.probes?.viewMisses ?? 0;
  if (!Array.isArray(views) || !views.length) return misses ? [NO_VIEWS] : [];
  if (!Array.isArray(inputs)) return [NO_INPUTS]; // a run that recorded views but not inputs can't tell a scroll from a move
  const out = views.filter(usable).map(stale).filter(Boolean);
  const times = inputs.map((x) => x.at).sort((x, y) => x - y);
  const last = new Map(); // the previous sample of each transcript and page load: O(1) per sample, not a scan back
  const tallies = new Map(); // each transcript’s counts, so a run that compared nothing says so
  for (const b of views) {
    const transcript = `${b.where}:${b.thread}`;
    const t = tallies.get(transcript) ?? { thread: b.thread, where: b.where, samples: 0, settled: 0, withInput: 0, compared: 0, skipped: 0 };
    tallies.set(transcript, t);
    t.samples++;
    if (!usable(b)) continue; // passed over, so the next settled sample is compared with the last settled one
    t.settled++;
    const page = pageKey(b);
    const a = last.get(page);
    last.set(page, b);
    if (!a) continue;
    if (inputBetween(times, a.at, b.at)) {
      t.withInput++;
      continue;
    }
    const r = moved(a, b);
    t.compared++;
    if (r === 'skipped') t.skipped++;
    else if (r) out.push(r);
  }
  for (const t of tallies.values()) out.push(...tallyRows(t));
  if (misses) out.push(missedRow(misses));
  return out;
}

export const VIEW_CHECKS = [
  {
    id: 'view-moved',
    inputs: ['probes'],
    issue: 531,
    run: viewMoved,
  },
];
