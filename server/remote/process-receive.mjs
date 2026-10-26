// What a remote turn’s child does with the daemon’s messages for its turn (process.mjs, whose header is the design):
// out.jsonl’s lines applied once each and acked, in.jsonl’s lines, the look for a line lost in a drop, and errors.
// Each takes the child first.

/** @typedef {import('./process.mjs').RemoteProcess} RemoteProcess */

/** Lines applied before an ack goes, at most. */
export const ACK_LINES = 64;
/** How long the first line not yet acked waits for its ack, at most. */
export const ACK_MS = 250;

/** @param {RemoteProcess} p @param {any} m */
export function handle(p, m) {
  if (p.ended || m?.turn !== p.turn) return;
  switch (m.type) {
    case 'started':
      return p.onStarted();
    case 'line':
      return m.log === 'in' ? p.applyIn(m) : p.apply(m);
    case 'written':
      p.inFlight = null;
      p.checking = null;
      p.inUpTo = Math.max(p.inUpTo, m.upTo);
      return p.pump();
    case 'caught-up':
      // A read’s first pass has sent what the log had (the Codex rebuild waits for both logs’).
      return void p.emit('caught-up', { log: m.log, size: m.size });
    case 'ended':
      p.ack();
      return p.finish(m.exit);
    case 'error':
      return p.onDaemonError(m);
  }
}

/** @param {RemoteProcess} p */
export function onStarted(p) {
  if (p.started) return;
  p.started = true;
  // Started after kill(): the stop sent then may have reached the daemon before the turn was there, so it goes again.
  if (p.killed) p.stopPending = !p.send('stop', { turn: p.turn });
  p.read();
}

/** @param {RemoteProcess} p @param {{ offset: number, next: number, text: string, cut?: boolean }} m */
export function apply(p, m) {
  if (m.offset < p.next) return; // already applied: its offset is its identity
  if (m.cut) {
    p.emit('cut', { offset: m.offset, next: m.next });
    p.note(`A line of the agent’s output at byte ${m.offset} was too long to send from the host, so it was left out.`);
  } else p.stdout.push(`${m.text}\n`);
  p.next = m.next;
  if (++p.unacked >= ACK_LINES) p.ack();
  else if (!p.ackTimer) {
    p.ackTimer = setTimeout(() => p.ack(), ACK_MS);
    p.ackTimer.unref?.();
  }
}

/** An in.jsonl line: emitted once, and looked at for a line lost in a drop. @param {{ offset: number, next: number, text: string, cut?: boolean }} m @param {RemoteProcess} p */
export function applyIn(p, m) {
  const c = p.checking;
  if (c && m.offset >= c.base) {
    if (!m.cut && m.text === c.line) p.settle(true);
    else if (m.next === c.end) p.settle(false);
  }
  if (m.offset < p.inNext) return;
  p.inNext = m.next;
  if (!m.cut) p.emit('stdin-line', { offset: m.offset, next: m.next, text: m.text });
}

/** The lost line was found in in.jsonl, or found missing and is sent again. @param {boolean} arrived @param {RemoteProcess} p */
export function settle(p, arrived) {
  const c = /** @type {NonNullable<typeof p.checking>} */ (p.checking);
  p.checking = null;
  p.inFlight = null;
  if (!arrived) {
    p.note('A line for the agent’s stdin was lost when the connection to the host dropped; it wasn’t on the host, so it was sent again.');
    p.queue.unshift(c.line);
  }
  p.pump();
}

/** @param {RemoteProcess} p @param {{ code: string, message: string, re?: string }} m */
export function onDaemonError(p, m) {
  if (m.re === 'start') {
    if (m.code === 'turn-exists' && p.startResent) return p.onStarted();
    return p.fail(Object.assign(new Error(m.message), { code: m.code }));
  }
  // Only the look for a lost line reads from an offset that may not be a line’s start: its end isn’t there.
  if (m.re === 'read' && m.code === 'bad-offset' && p.checking) return p.settle(false);
  if (m.re === 'read') return p.fail(Object.assign(new Error(m.message), { code: m.code }));
  if (m.re === 'write') {
    p.note(`A line for the agent’s stdin wasn’t written on the host: ${m.message}`);
    p.inFlight = null;
    if (m.code === 'turn-ended') p.queue = [];
    return p.pump();
  }
  // Killed before its start was confirmed, and the host has no such turn: the start never reached it, and isn’t sent
  // again, so p is the end, as a kill before start is.
  if (m.re === 'stop' && m.code === 'no-turn' && p.killed && !p.started) return p.finish({ code: null, signal: 'SIGINT' });
  // Otherwise a refused ack or stop changes nothing: the turn’s end still comes as `ended`.
}
