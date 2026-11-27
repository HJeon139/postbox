// What a reply shows about Stop: why it stopped (#215, #249), the background jobs it started that are still running,
// each with its own Stop (#129), and whether its header says it’s running (#288). jobRows moved from app/js/thread.mjs.

import { api } from './client.mjs';
import { h, timeOf } from './dom.mjs';
import { heldLine } from './held-line.mjs';
import { jobHostNote } from './thread-host.mjs';
import { say, toast } from './ui.mjs';

/**
 * The jobs whose Stop was pressed and whose stop hasn’t failed, by session and job (#1837). A running reply’s rows are
 * drawn anew at each step (paintLive, activity-paint.mjs), so a Stop drawn while its stop is in flight is drawn pressed,
 * and a second press sends nothing. It’s marked with aria-disabled, not disabled, so it can keep focus.
 */
const stopping = new Set();
const stopKey = (/** @type {string} */ sessionId, /** @type {string} */ job) => `${sessionId}\n${job}`;

/**
 * Puts a reply’s job rows drawn anew in place of the old ones, and focus back on the same job’s button if it was on one
 * (#1837), as focus in the live steps stays (paintLive). @param {Element} old @param {Element} rows
 */
export function swapJobs(old, rows) {
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  const job = old.contains(active) ? active?.dataset.job : undefined;
  old.replaceWith(rows);
  if (job) /** @type {HTMLElement | null} */ (rows.querySelector(`[data-job="${CSS.escape(job)}"]`))?.focus();
}

/**
 * The background jobs a reply started that are still running (#129), outside the folded steps so you can see them, each
 * with its own Stop. The call returned at once, so without this the step would read done while the job runs on.
 */
export function jobRows(it, steps) {
  const jobs = steps.filter((s) => s.job && s.state === 'running');
  if (!jobs.length || !it.sessionId) return null;
  return h(
    'ul.bg-jobs',
    { 'aria-label': 'Background jobs' },
    jobs.map((s) =>
      h(
        'li',
        h('span.g.g-running', { role: 'img', 'aria-label': 'running' }),
        // What Postbox kept running for it, when it couldn’t tell which process was the job (#164).
        h('span.grow', h('span.dim', 'Background job · '), h('span.mono', s.label), s.detail ? h('span.job-note', s.detail) : null),
        // A job of a turn on a host has no Stop of its own (#120): the daemon stops the turn as a whole.
        jobHostNote(it) ??
          h(
            'button.btn.sm',
            {
              type: 'button',
              'aria-label': `Stop the background job “${s.label}”`,
              'aria-disabled': stopping.has(stopKey(it.sessionId, s.job)) ? 'true' : null,
              'data-session': it.sessionId,
              'data-job': s.job,
              onclick: () => {
                const key = stopKey(it.sessionId, s.job);
                if (stopping.has(key)) return;
                stopping.add(key);
                // Every Stop for this job, the one pressed or one drawn since, shows whether its stop is in flight.
                const pressed = (/** @type {boolean} */ on) => {
                  const sel = `.bg-jobs button[data-session="${CSS.escape(it.sessionId)}"][data-job="${CSS.escape(s.job)}"]`;
                  for (const b of document.querySelectorAll(sel)) {
                    if (on) b.setAttribute('aria-disabled', 'true');
                    else b.removeAttribute('aria-disabled');
                  }
                };
                pressed(true);
                api(`/api/sessions/${it.sessionId}/jobs/${encodeURIComponent(s.job)}/stop`, {})
                  .then(() => say(`Stopped the background job “${s.label}”.`))
                  .catch((err) => {
                    stopping.delete(key);
                    pressed(false);
                    toast({ title: 'Couldn’t stop the job', text: err.message, level: 'blocking' });
                  });
              },
            },
            'Stop',
          ),
      ),
    ),
  );
}

/** A stopped reply’s tag for each stop that isn’t your Stop, by its stopReason. @type {Record<string, (at: string) => string>} */
const STOPPED_BY = {
  'send-now': (at) => `Interrupted by Send now at ${at}`,
  store: (at) => `Stopped at ${at}: Postbox couldn’t save changes`,
  // A run clock’s, in a timed trial (#1526): the person didn’t press Stop.
  clock: (at) => `Stopped at ${at}: its run clock reached its budget`,
  pause: (at) => `Stopped at ${at}: its run clock was paused`,
};

/**
 * A stopped reply’s tag: what stopped it, from what the server recorded (stopReason). Send now isn’t your Stop, Keep
 * running left its jobs running, a store that couldn’t save stopped every turn (ST-3), and a run clock stops its agent
 * at its budget or its pause (#1526). A reply stored before the reason was recorded reads as it always did.
 * @returns {any[]}
 */
export function stoppedTag(it) {
  const at = timeOf(it.stoppedAt ?? it.at);
  const text = Object.hasOwn(STOPPED_BY, it.stopReason)
    ? STOPPED_BY[it.stopReason](at)
    : `Stopped by you at ${at}${it.stopReason === 'kept-jobs' ? ' · its background work kept running' : ''}`;
  // A reply a restart or a store outage cut off before it had words says what its turn held first (held-line.mjs).
  return [heldLine(it), h('span.stopped-tag', text)];
}

/**
 * What a reply’s header adds while one of its steps runs. A background job’s step runs on after its call returned,
 * and after a Stop that kept it (#288): that’s its background work running, as a stopped reply’s tag says, not the
 * reply. A stopped turn settled every other step, so a stopped reply never reads as running.
 */
export function runningNote(it, steps) {
  const running = steps.filter((s) => s.state === 'running');
  if (it.status !== 'stopped' && running.some((s) => !s.job)) return ' · running';
  return running.some((s) => s.job) ? ' · background work running' : '';
}

/**
 * What Stop says once it’s done, for an agent with background jobs: that its reply had already ended, or that it
 * stopped with its jobs or without them. @param {any} se @param {any} r  Stop’s answer @param {'stop' | 'keep'} jobs
 * @param {boolean} one  whether it has one job
 */
export function stoppedSaid(se, r, jobs, one) {
  if (r?.ended) return `${se.handle}’s reply had already ended.`;
  if (jobs === 'keep') return `Stopped ${se.handle}. ${one ? 'Its background job keeps' : 'Its background jobs keep'} running.`;
  return `Stopped ${se.handle} and ${one ? 'its background job' : 'its background jobs'}.`;
}
