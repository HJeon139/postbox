// In-process signals between services (designs/architecture/services.md, “Bus”): a service that used to call into
// another concern raises a signal, and the composition root (server/runtime.mjs) registers what listens. Listeners run
// synchronously, in the order they were registered, where the direct call ran, and a listener’s throw reaches the
// emitter as the call’s did. Nothing is kept: the store’s own events stay the store’s.

export class Bus {
  constructor() {
    /** @type {Map<string, ((data: any) => void)[]>} signal → its listeners, in the order they were registered */
    this.listeners = new Map();
  }

  /** Listens to a signal. @param {string} signal @param {(data: any) => void} fn */
  on(signal, fn) {
    const list = this.listeners.get(signal) ?? [];
    list.push(fn);
    this.listeners.set(signal, list);
  }

  /**
   * Raises a signal: each listener runs now, in order, before this returns. One registered meanwhile hears the next.
   * @param {string} signal @param {any} data
   */
  emit(signal, data) {
    for (const fn of [...(this.listeners.get(signal) ?? [])]) fn(data);
  }
}
