// Which turns run now (designs/architecture/services.md, “Running”): the live turn per session, the stopped turns
// whose process hasn’t exited yet (#126), the sessions whose turn on a host, from before a restart or a link that gave
// up, waits to be attached again (#1135), and whether Postbox is shutting down. It depends on nothing. Only Turns
// writes it; until Turns is a service, Runtime keeps `turns` and `exiting` as getters onto its maps for the code that
// still takes the runtime.
//
// Its invariants, which a write that would break one throws for: at most one live turn per session; no turn starts
// while the session’s stopped one is still exiting; once closing, nothing starts. A session awaiting attach is busy,
// so the queue and wakes hold what’s for it, but begin doesn’t refuse it: Send now, a direct delivery and a scheduled
// wake reach deliver without the queue and start a turn there, as they did before Running, a gap #1135 leaves open.

/** @typedef {any} Turn  a live turn, as deliver.mjs’s newTurn makes it; Running reads only its sessionId */
/** @typedef {{ turn: Turn, held: any[], silent: boolean }} Exiting  what waits for a stopped turn’s exit */

export class Running {
  constructor() {
    /** @type {Map<string, Turn>} sessionId → its live turn */
    this.turns = new Map();
    /** @type {Map<string, Exiting>} sessionId → its stopped turn whose process hasn’t exited yet */
    this.exiting = new Map();
    /** @type {Map<string, string>} sessionId → the host whose turn it waits to attach again */
    this.awaiting = new Map();
    this.shuttingDown = false;
  }

  /** The session’s live turn, if one runs. @param {string} sessionId */
  turnOf(sessionId) {
    return this.turns.get(sessionId);
  }

  /** The session’s stopped turn still exiting, with what waits for it, if there is one. @param {string} sessionId */
  exitOf(sessionId) {
    return this.exiting.get(sessionId);
  }

  /**
   * A turn running, or a stopped one still exiting: what moving an agent waits for (Placement). Narrower than busy():
   * an agent may move off a host whose turn waits to be attached, since that host may never answer (#1135).
   * @param {string} sessionId
   */
  midTurn(sessionId) {
    return this.turns.has(sessionId) || this.exiting.has(sessionId);
  }

  /** Whether the session’s turn on a host waits to be attached again (#1135). @param {string} sessionId */
  awaitsAttach(sessionId) {
    return this.awaiting.has(sessionId);
  }

  /**
   * Whether a session can’t take a delivery now, so what’s queued for it waits: a turn running, a stopped one still
   * exiting, or a host turn waiting to be attached again. The one rule a wake and a drain read.
   * @param {string} sessionId
   */
  busy(sessionId) {
    return this.midTurn(sessionId) || this.awaiting.has(sessionId);
  }

  /** Every live turn, as a list of its own, so ending one while going through them skips none. */
  all() {
    return [...this.turns.values()];
  }

  /** Postbox is shutting down: no new turn starts, since its process would outlive Postbox. */
  get closing() {
    return this.shuttingDown;
  }

  /** A turn starts. @param {Turn} turn */
  begin(turn) {
    const id = turn.sessionId;
    if (this.shuttingDown) throw new Error(`Postbox is closing, so session ${id}’s turn can’t start.`);
    if (this.turns.has(id)) throw new Error(`Session ${id} already has a turn running.`);
    if (this.exiting.has(id)) throw new Error(`Session ${id}’s stopped turn is still exiting.`);
    this.turns.set(id, turn);
  }

  /**
   * The session’s live turn was stopped, and waits for its process to exit. It stays live until end(), so what its
   * abort runs still finds it.
   * @param {string} sessionId @param {Exiting} entry
   */
  exit(sessionId, entry) {
    if (this.turns.get(sessionId) !== entry.turn) throw new Error(`The turn exiting for session ${sessionId} isn’t its live turn.`);
    this.exiting.set(sessionId, entry);
  }

  /** The session’s live turn leaves. @param {string} sessionId */
  end(sessionId) {
    this.turns.delete(sessionId);
  }

  /** The session’s stopped turn has exited. @param {string} sessionId */
  exited(sessionId) {
    this.exiting.delete(sessionId);
  }

  /** The session’s turn on a host waits to be attached again (#1135). @param {string} sessionId @param {string} hostId */
  awaitAttach(sessionId, hostId) {
    this.awaiting.set(sessionId, hostId);
  }

  /** The session’s turn on a host no longer waits: attached, given up, or its agent moved off that host. @param {string} sessionId */
  attached(sessionId) {
    this.awaiting.delete(sessionId);
  }

  /** Postbox is shutting down (#126). */
  close() {
    this.shuttingDown = true;
  }
}
