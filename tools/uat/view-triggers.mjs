// The long room’s view triggers (#508 lane, tests/uat/e2e/scenarios/bigroom.md): what the page draws far from the view.
// tools/uat/triggers.mjs adds them to TRIGGERS. Each reads the probes the runner records from the page
// (tools/uat/diagram-probe.mjs, tools/uat/doc-query-probe.mjs, tools/uat/view-probe.mjs), not the state, since what’s
// drawn isn’t in it.

import { onBigRoomFirstDay } from './big-room.mjs';

/**
 * The page had asked for fewer diagram pages than it had diagram frames, with one out of view and not drawn, and a later
 * sample of the same page load shows more pages asked for and that frame drawn: the page deferred the frame until it
 * neared the view, then loaded it (#695, #701). An eager frame is requested as it’s mounted, so without #701 the page
 * has asked for every frame by the first sample, and this stays silent. A sample whose timing buffer was full can’t
 * count, so it’s skipped. The runner’s screenshots scroll to each diagram after the first sample, which loads it.
 * It can miss, never fire falsely, once a page has asked for as many pages as it has frames: requested counts every
 * diagram page since the load, in any conversation, so after a switch back, or once every frame has loaded, it stays
 * silent. O(samples² × frames²), with samples at most the run’s steps.
 * @param {{ probes?: { diagrams?: any[] } }} f
 */
function diagramDeferred(f) {
  const samples = (f.probes?.diagrams ?? []).filter((s) => !s.full);
  for (const [i, s] of samples.entries()) {
    if (s.requested >= s.frames.length) continue;
    const samePage = samples.slice(i + 1).filter((later) => later.origin === s.origin);
    const waiting = s.frames.filter((fr) => !fr.loaded && !fr.inView);
    for (const fr of waiting) {
      const drawn = samePage.find((later) => later.requested > s.requested && later.frames.some((x) => x.key === fr.key && x.loaded));
      if (!drawn) continue;
      return [
        {
          at: s.at,
          evidence: `At step ${s.step} the page had asked for ${s.requested} of its ${s.frames.length} diagram pages, and the diagram in ${fr.key} was out of view and not drawn; by step ${drawn.step} it had asked for ${drawn.requested}, and that diagram had drawn.`,
        },
      ];
    }
  }
  return [];
}

/** At least this many session events in one page load before a count of no scans means anything. */
export const SESSION_FLOOR = 5;
/** A room this big, as bigroom’s is, where a scan over the whole document costs what #564-b1 removed. */
export const ROOM_FLOOR = 1000;

/**
 * The page handled session events in a room of ROOM_FLOOR items or more with no lookup over the whole document: a
 * sample of a page load that had heard SESSION_FLOOR session events or more, with no scan among them (#564-b1). Before
 * #564-b1 each session event ran three, so this stays silent. A page load that heard fewer session events can't fire,
 * so a probe that heard nothing can't pass for one that heard events and saw no scans. O(samples).
 * @param {{ probes?: { docQueries?: any[] } }} f
 */
function sessionScoped(f) {
  const samples = f.probes?.docQueries ?? [];
  const heard = samples.filter((s) => s.sessionEvents >= SESSION_FLOOR && s.items >= ROOM_FLOOR);
  if (!heard.length || heard.some((s) => s.scanCount > 0)) return [];
  const s = heard[heard.length - 1];
  return [
    {
      at: s.at,
      evidence: `By step ${s.step} the page had handled ${s.sessionEvents} session events in a conversation of ${s.items} items with no lookup over the whole document (${s.byId} by id).`,
    },
  ];
}

/**
 * You paged back through the big room to its first day (bigroom.md, phase 1; #531): a settled sample of the view,
 * reading, anchored at one of the seeded room’s first-day items. The first such sample is the evidence.
 * @param {{ probes?: { views?: any[] } }} f
 */
function windowPagedBack(f) {
  const s = (f.probes?.views ?? []).find((x) => x.settled === true && x.mode === 'reading' && onBigRoomFirstDay(x.anchorId));
  if (!s) return [];
  const where = s.where === 'panel' ? 'the side panel' : 'the conversation';
  return [{ at: s.at, evidence: `At step ${s.step}, ${where} was reading at ${s.anchorId}, one of the seeded room’s first-day items.` }];
}

/**
 * A settled sample of a room of more than 1,000 items with more than half of them skipped (a browser that can't say
 * has skipped: null, which never counts): the run read a long room
 * with the browser skipping the items off screen (#712a, tools/uat/skip-probe.mjs). Its check, rows-skipped
 * (tools/uat/checks-view.mjs), fires on the opposite: fewer than half. O(samples).
 * @param {{ probes?: { skipped?: any[] } }} f
 */
function itemsSkipped(f) {
  const s = (f.probes?.skipped ?? []).find((x) => x.settled && x.items > 1000 && x.skipped * 2 > x.items);
  if (!s) return [];
  return [{ at: s.at, evidence: `At step ${s.step}, ${s.skipped} of the conversation’s ${s.items} items were skipped.` }];
}

export const VIEW_TRIGGERS = {
  'window-paged-back': {
    issue: 531,
    says: 'you read at one of the big room’s first-day items, having paged back to its start',
    recorded: (f) => Array.isArray(f.probes?.views),
    run: windowPagedBack,
  },
  'items-skipped': {
    issue: 712,
    says: 'the page read a room of more than 1,000 items with most of them skipped',
    recorded: (f) => Array.isArray(f.probes?.skipped),
    run: itemsSkipped,
  },
  'diagram-deferred': {
    issue: 695,
    says: 'the page asked for fewer diagram pages than it had diagrams, and a diagram out of view loaded and drew later',
    recorded: (f) => Array.isArray(f.probes?.diagrams),
    run: diagramDeferred,
  },
  'session-scoped': {
    issue: 564,
    says: 'the page handled session events in a room of 1,000 items or more without a lookup over the whole document',
    recorded: (f) => Array.isArray(f.probes?.docQueries),
    run: sessionScoped,
  },
};
