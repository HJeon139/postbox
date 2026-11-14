// A first-in, first-out list whose shift() costs the same at any length. Array.prototype.shift() moves every element
// behind the first once V8 can’t trim the array’s start in place, so the store’s held emits, taken one at a time,
// cost seconds at 100,000 (tests/store-commit-scale.test.mjs).

/** @template T */
export class Fifo {
  /** @type {T[]} */
  #items = [];
  #head = 0; // where the front is in #items: the slots before it are taken

  get length() {
    return this.#items.length - this.#head;
  }

  /** The element i places from the front. @param {number} i */
  at(i) {
    return this.#items[this.#head + i];
  }

  /** @param {T} item */
  push(item) {
    this.#items.push(item);
  }

  shift() {
    if (!this.length) return undefined;
    const item = this.#items[this.#head++];
    // The taken slots go in one step once they’re half the array, so a shift costs the same on average at any length,
    // and what they hold is kept no longer than that.
    if (this.#head * 2 >= this.#items.length) {
      this.#items.splice(0, this.#head);
      this.#head = 0;
    }
    return item;
  }

  *[Symbol.iterator]() {
    for (let i = this.#head; i < this.#items.length; i++) yield this.#items[i];
  }
}
