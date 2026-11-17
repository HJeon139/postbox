// Each harness’s quota usage as the harness-event contract’s `quota` kind (#442; designs/architecture/adapters.md,
// “Quota: each backend’s usage, in the composer”): a status, and windows each with a name, the share used from 0 to 1,
// and when it resets. Only Claude Code, the Agent SDK and Codex report one; Postbox never makes up a figure for a
// harness that doesn’t. These are the person’s own figures: recorded fixtures keep them scrubbed (tools/privacy-check.mjs).

/** Claude’s window names, as the bars show them. */
const CLAUDE_WINDOWS = { five_hour: '5 h', seven_day: '7 d', seven_day_opus: '7 d Opus', seven_day_sonnet: '7 d Sonnet' };

/**
 * A share from 0 to 1. Claude’s utilization is one (its CLI shows Math.round(utilization * 100)), but a figure over 1 is
 * read as a percent, up to 100, and anything else is none, so a change of scale never draws a full bar by mistake.
 * @param {unknown} x @returns {number | null}
 */
export function share(x) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return null;
  if (x <= 1) return x;
  return x <= 100 ? x / 100 : null;
}

/** Epoch seconds, as both harnesses send a reset, in ms; a figure already in ms is kept. @param {unknown} t */
function resetMs(t) {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return null;
  return t > 1e12 ? t : t * 1000;
}

/**
 * Claude Code’s and the Agent SDK’s `rate_limit_event`’s `rate_limit_info`: each of its unified windows, else the one
 * window it names. A rejected limit with no overage to go on with is out; a warning is a warning.
 * @param {any} info @returns {{ status: string, windows: any[] } | null}
 */
export function claudeQuota(info) {
  if (!info || typeof info !== 'object') return null;
  const windows = claudeWindows(info)
    .map(([type, w]) => ({ name: CLAUDE_WINDOWS[type] ?? null, used: share(w?.utilization), resetsAt: resetMs(w?.resetsAt) }))
    .filter((w) => w.name && w.used !== null);
  if (!windows.length) return null;
  return { status: claudeStatus(info), windows };
}

/** Its unified windows by type, else the one window it names. @param {any} info @returns {[string, any][]} */
function claudeWindows(info) {
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? Object.entries(info.unifiedWindows) : [];
  if (unified.length) return unified;
  return info.rateLimitType ? [[info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt }]] : [];
}

/** Out when it rejected with no overage to go on with, a warning when it warned, else ok. @param {any} info */
function claudeStatus(info) {
  const overage = info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning';
  if (info.status === 'rejected' && !overage) return 'out';
  return info.status === 'allowed_warning' ? 'warning' : 'ok';
}

/** A window’s length as the bars name it: 300 minutes is “5 h”, 10,080 is “7 d”. @param {unknown} mins */
function lengthName(mins) {
  if (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0) return null;
  if (mins % 1440 === 0) return `${mins / 1440} d`;
  if (mins % 60 === 0) return `${mins / 60} h`;
  return `${mins} min`;
}

/**
 * Codex’s `account/rateLimits/updated`’s `rateLimits`: its primary and secondary windows, each with the percent used.
 * Out once Codex says which limit was reached.
 * @param {any} limits @returns {{ status: string, windows: any[] } | null}
 */
export function codexQuota(limits) {
  if (!limits || typeof limits !== 'object') return null;
  const windows = [limits.primary, limits.secondary]
    .filter((w) => w && typeof w === 'object')
    .map((w) => ({ name: lengthName(w.windowDurationMins), used: share(percentOf(w)), resetsAt: resetMs(w.resetsAt) }))
    .filter((w) => w.name && w.used !== null);
  if (!windows.length) return null;
  return { status: limits.rateLimitReachedType ? 'out' : 'ok', windows };
}

/** A Codex window’s percent used, 0 to 100, as a share’s input: always read as a percent, so 1 is 1%. @param {any} w */
function percentOf(w) {
  const pct = w.usedPercent;
  return typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct / 100 : null;
}

/** Emits a harness’s report as the contract’s `quota` kind, when it has one. @param {(e: any) => void} emit @param {any} report */
export function emitQuota(emit, report) {
  if (report) emit({ kind: 'quota', ...report });
}
