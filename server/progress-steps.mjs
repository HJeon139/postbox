// A progress block’s step times, which update_block keeps beside the block. Moved out of server/blocks.mjs.

import { formatDuration } from '../shared/text.mjs';

/**
 * A progress update’s step times, kept beside the block: startedAt when a step starts running, endedAt when it
 * stops. A step that finishes without a duration gets one from them.
 * @param {any} item  the block as it was  @param {any} block  the update  @param {number} now
 */
export function stampSteps(item, block, now) {
  const was = new Map((item.block.steps ?? []).map((s) => [s.id, s.state]));
  /** @type {Record<string, { startedAt?: number, endedAt?: number }>} */
  const times = {};
  const steps = block.steps.map((sent) => {
    const before = was.get(sent.id);
    // Only Postbox marks a step stalled; from the agent, it means still running.
    const s = sent.state === 'stalled' && before !== 'stalled' ? { ...sent, state: 'running' } : sent;
    const t = { ...(item.stepTimes?.[s.id] ?? {}) };
    const going = before === 'running' || before === 'stalled';
    // A step that was running when the block was shown started then.
    if (going) t.startedAt ??= item.at;
    if (s.state === 'running') {
      if (!going) t.startedAt = now;
      delete t.endedAt;
    } else if (going && s.state !== 'pending') t.endedAt = now;
    times[s.id] = t;
    const finished = s.state === 'done' || s.state === 'failed';
    return finished && !s.duration && t.startedAt && t.endedAt ? { ...s, duration: formatDuration(t.endedAt - t.startedAt) } : s;
  });
  return { block: { ...block, steps }, stepTimes: times };
}
