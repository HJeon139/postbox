// Each harness’s quota usage as the harness-event contract’s `quota` kind (#442; designs/architecture/adapters.md,
// “Quota: each backend’s usage, in the composer”): a status, and windows each with a name, the share used from 0 to 1,
// and when it resets. Only Claude Code, the Agent SDK, Codex and Antigravity report one; Postbox never makes up a
// figure for a harness that doesn’t. These are the person’s own figures: recorded fixtures keep them scrubbed (tools/privacy-check.mjs).

/** Claude’s window names, as the bars show them. */
const CLAUDE_WINDOWS = { five_hour: '5 h', seven_day: '7 d', seven_day_opus: '7 d Opus', seven_day_sonnet: '7 d Sonnet' };

/**
 * A share from 0 to 1, of a figure on a scale of 1 (Claude’s utilization, which its CLI shows as
 * Math.round(utilization * 100)) or 100. On a scale of 1, a figure just over it, as overage can give, is a full share;
 * on a scale of 100, one over it is none, so a change of scale never draws a bar it can’t stand behind.
 * @param {unknown} x @param {number} scale @returns {number | null}
 */
export function share(x, scale) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return null;
  if (scale === 1) return Math.min(x, 1);
  return x <= scale ? x / scale : null;
}

/** An event’s scale, read once for all its figures: any over 1.5 means it’s in percents. @param {unknown[]} figures */
const scaleOf = (figures) => (figures.some((x) => typeof x === 'number' && x > 1.5) ? 100 : 1);

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
  const given = claudeWindows(info);
  const scale = scaleOf(given.map(([, w]) => w?.utilization));
  const windows = given
    .map(([type, w]) => ({ name: CLAUDE_WINDOWS[type] ?? null, used: share(w?.utilization, scale), resetsAt: resetMs(w?.resetsAt) }))
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
 * Out once Codex says which limit was reached. An update is sparse, so each window carries its limit (`limitId`; none for
 * the default one), and the record merges them by limit and name (quota-usage.mjs).
 * @param {any} limits @returns {{ status: string, windows: any[] } | null}
 */
export function codexQuota(limits) {
  if (!limits || typeof limits !== 'object') return null;
  const limit = typeof limits.limitId === 'string' && limits.limitId && limits.limitId !== 'codex' ? namedLimit(limits) : {};
  const windows = [limits.primary, limits.secondary]
    .filter((w) => w && typeof w === 'object')
    .map((w) => ({ name: lengthName(w.windowDurationMins), used: share(percentOf(w), 100), resetsAt: resetMs(w.resetsAt), ...limit }))
    .filter((w) => w.name && w.used !== null);
  if (!windows.length) return null;
  return { status: limits.rateLimitReachedType ? 'out' : 'ok', windows };
}

/** A limit other than the default, kept apart by its id and shown by its name, where Codex gives one. @param {any} limits */
function namedLimit(limits) {
  const name = typeof limits.limitName === 'string' && limits.limitName ? { limitName: limits.limitName } : {};
  return { limit: limits.limitId, ...name };
}

/** A Codex window’s percent used, 0 to 100: always a percent, so 1 is 1%. @param {any} w */
const percentOf = (w) => w.usedPercent;

/** Antigravity’s window names, as the bars show them, and the pool its default limit is. */
const AGY_WINDOWS = { '5h': '5 h', weekly: '7 d' };
const AGY_DEFAULT_POOL = 'Gemini Models';

/**
 * Antigravity’s `/usage` (agy-usage.mjs): each model pool’s windows, with the share remaining from 0 to 1 and an ISO
 * reset time. Every pool is reported, so the backend’s bar shows whichever is most used; a pool other than Gemini’s,
 * Claude and GPT models’ say, is a limit of its own, named after the window, as Codex’s are. Out once a window has
 * nothing left.
 * @param {any} data @returns {{ status: string, windows: any[] } | null}
 */
export function agyQuota(data) {
  const pools = Array.isArray(data?.groups) ? data.groups : [];
  const windows = pools
    .flatMap((pool) => (Array.isArray(pool?.buckets) ? pool.buckets.map((b) => agyWindow(pool, b)) : []))
    .filter((w) => w.name && w.used !== null);
  if (!windows.length) return null;
  return { status: windows.some((w) => w.used >= 1) ? 'out' : 'ok', windows };
}

/** One of a pool’s windows. @param {any} pool @param {any} b */
function agyWindow(pool, b) {
  const left = b?.remaining_fraction;
  const used = typeof left === 'number' && left >= 0 && left <= 1 ? share(1 - left, 1) : null;
  const at = typeof b?.reset_time === 'string' ? Date.parse(b.reset_time) : Number.NaN;
  const name = typeof pool.name === 'string' && pool.name ? pool.name : null;
  const limit = name && name !== AGY_DEFAULT_POOL ? { limit: name, limitName: name } : {};
  return { name: AGY_WINDOWS[b?.window] ?? null, used, resetsAt: Number.isFinite(at) ? at : null, ...limit };
}

/** Emits a harness’s report as the contract’s `quota` kind, when it has one. @param {(e: any) => void} emit @param {any} report */
export function emitQuota(emit, report) {
  if (report) emit({ kind: 'quota', ...report });
}
