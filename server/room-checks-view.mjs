// The transcript’s view (#531, designs/508/b1-view-state.md): what you were reading moved, or the view’s mode changed,
// when nothing you or the runner did came between. It reads the view probe the UAT records each step
// (tools/uat/view-probe.mjs, facts.probes.views) and the inputs the run made (facts.probes.inputs), and should never
// fire. A run with no inputs recorded can’t tell a scroll from a move, so the check says nothing of it.

/** A move of more than this, in px, is one; a published offset is rounded to 0.1 px. */
const MOVED_PX = 1;
/** Following, the view may sit this far above the end, as app/js/view-state.mjs’s atEnd allows. */
const END_PX = 2;

const px = (n) => `${Math.round(n * 10) / 10} px`;
const samePage = (a, b) => a.where === b.where && a.thread === b.thread && a.origin === b.origin;
/** A sample the check may read: settled, and not one the runner caused. */
const usable = (s) => s.settled === true && s.cause !== 'runner';
const where = (s) => (s.where === 'panel' ? 'the side panel' : 'the conversation');

/** One sample: the offset the page published for its anchor isn’t where the anchor is (a stale publish). */
function stale(s) {
  if (s.mode !== 'reading' || typeof s.actual !== 'number' || typeof s.expected !== 'number') return null;
  if (Math.abs(s.actual - s.expected) <= MOVED_PX) return null;
  return {
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
  if (a.mode !== b.mode)
    return {
      title: 'The view changed between following and reading without a scroll',
      evidence: `Between steps ${a.step} and ${b.step}, with no input between, ${where(b)} went from ${a.mode} to ${b.mode}.`,
    };
  if (b.mode === 'following')
    return b.gap > END_PX
      ? {
          title: 'The view stopped following the newest message without a scroll',
          evidence: `At step ${b.step}, ${where(b)} was following, ${px(b.gap)} above the end, with no input since step ${a.step}.`,
        }
      : null;
  if (!b.prev || typeof a.actual !== 'number') return 'skipped';
  if (Math.abs(b.prev.actual - a.actual) <= MOVED_PX) return null;
  return {
    title: 'What you were reading moved without a scroll',
    evidence: `Between steps ${a.step} and ${b.step}, with no input between, ${b.prev.anchorId} in ${where(b)} went from ${px(a.actual)} to ${px(b.prev.actual)} down the view.`,
  };
}

/** @param {{ probes?: { views?: any[], inputs?: { at: number }[] } }} f */
function viewMoved(f) {
  const views = f.probes?.views;
  const inputs = f.probes?.inputs;
  if (!Array.isArray(views) || !Array.isArray(inputs)) return [];
  const out = views.filter(usable).map(stale).filter(Boolean);
  const skipped = new Map();
  for (const [i, b] of views.entries()) {
    const a = views.slice(0, i).findLast((x) => samePage(x, b));
    if (!a || !usable(a) || !usable(b)) continue;
    if (inputs.some((x) => x.at >= a.at && x.at <= b.at)) continue;
    const r = moved(a, b);
    const key = `${b.where}:${b.thread}`;
    const n = skipped.get(key) ?? { thread: b.thread, where: b.where, skipped: 0, pairs: 0 };
    skipped.set(key, { ...n, pairs: n.pairs + 1, skipped: n.skipped + (r === 'skipped' ? 1 : 0) });
    if (r && r !== 'skipped') out.push(r);
  }
  for (const s of skipped.values()) {
    if (!s.skipped) continue;
    out.push({
      key: `view-moved:unverified:${s.where}:${s.thread}`,
      issue: null,
      title: `view-moved couldn’t check every step in ${where(s)}`,
      evidence: `${s.skipped} of ${s.pairs} pairs of steps with no input between went unchecked: the earlier step’s anchor wasn’t on the page any more, so where it went can’t be measured.`,
      verdict: 'measurement',
      note: 'Not a defect: an anchor that left the page can’t be measured.',
      unverified: { check: 'view-moved', thread: s.thread },
    });
  }
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
