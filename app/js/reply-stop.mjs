// What a reply shows about Stop: why it stopped (#215, #249), the background jobs it started that are still running,
// each with its own Stop (#129), and whether its header says it’s running (#288). jobRows moved from app/js/thread.mjs.

import { api } from './client.mjs';
import { h, timeOf } from './dom.mjs';
import { jobHostNote } from './thread-host.mjs';
import { say, toast } from './ui.mjs';

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
              onclick: (e) => {
                const b = e.currentTarget;
                b.disabled = true;
                api(`/api/sessions/${it.sessionId}/jobs/${encodeURIComponent(s.job)}/stop`, {})
                  .then(() => say(`Stopped the background job “${s.label}”.`))
                  .catch((err) => {
                    b.disabled = false;
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

/**
 * A stopped reply’s tag: what stopped it, from what the server recorded (stopReason). Send now isn’t your Stop, Keep
 * running left its jobs running, and a store that couldn’t save stopped every turn (ST-3). A reply stored before the
 * reason was recorded reads as it always did.
 */
export function stoppedTag(it) {
  const at = timeOf(it.stoppedAt ?? it.at);
  const text =
    it.stopReason === 'send-now'
      ? `Interrupted by Send now at ${at}`
      : it.stopReason === 'store'
        ? `Stopped at ${at}: Postbox couldn’t save changes`
        : `Stopped by you at ${at}${it.stopReason === 'kept-jobs' ? ' · its background work kept running' : ''}`;
  return h('span.stopped-tag', text);
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
