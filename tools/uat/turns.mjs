// How the runner waits on the agents’ turns between steps, and stops one when the tester asks it to.

import { sleep } from '../cdp.mjs';

/** Waits until no agent under test is working, sampling what the screen says meanwhile. */
export async function settle({ api, d, threadsUnderTest, facts, midTurnChecks, opt }) {
  const end = Date.now() + Number(opt['turn-timeout']) * 1000;
  let calm = 0;
  while (Date.now() < end) {
    await sleep(1500);
    const st = (await api('/api/state')).state;
    const ids = threadsUnderTest(st);
    const sessions = ids
      .flatMap((t) => st.threads[t]?.members ?? [])
      .map((id) => st.sessions[id])
      .filter(Boolean);
    const working = sessions.filter((se) => ['think', 'tool', 'gen'].includes(se.state));
    const checking = Object.values(st.apps).some((a) => ids.includes(a.threadId) && ['pending', 'fixing'].includes(a.check?.status));
    const thinking = working.filter((se) => se.state !== 'gen').map((se) => se.handle);
    if (thinking.length) facts.samples.push({ busy: thinking, rows: (await d.working()).length });
    if (working.length) await midTurnChecks(st);
    calm = working.length || checking ? 0 : calm + 1;
    if (calm >= 2) return null;
  }
  await d.stopAll();
  return `An agent was still working after ${opt['turn-timeout']} s, so the run pressed Stop.`;
}

/** The tester’s send_then_stop: sends a message, waits, and presses Stop on the active reply. */
export async function sendThenStop(d, a) {
  await d.send(a.text ?? '');
  await sleep(Math.max(1, Math.min(10, a.seconds ?? 2)) * 1000);
  await d.stopAll();
  return 'Pressed Stop on the active reply.';
}
