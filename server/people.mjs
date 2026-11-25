// The people this Postbox knows (#558, prototype): each principal a provider proved (server/identity/index.mjs)
// resolves to one person, made the first time they’re seen, with a profile they can edit.
//
// Prototype storage: people.json in the data folder, written atomically. The design’s store is the event log, as a
// state key whose public shape is shared/people.mjs’s publicPerson; this file stands in until the shape is agreed.

import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { byline, handleFor, peopleFacts, profileEdit, publicPerson } from '../shared/people.mjs';
import { httpError } from './helpers.mjs';

/** How many entries a person’s queue keeps, the newest. */
const QUEUE = 200;

export class People {
  /** @param {{ dataDir: string, taken: (handle: string) => boolean, mode: string }} opts  taken: whether an agent holds a handle */
  constructor({ dataDir, taken, mode }) {
    this.file = join(dataDir, 'people.json');
    this.taken = taken;
    this.mode = mode;
    /** @type {any[]} */
    this.list = [];
    try {
      this.list = JSON.parse(readFileSync(this.file, 'utf8')).people ?? [];
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'ENOENT') throw new Error(`Postbox couldn’t read ${this.file}: ${/** @type {Error} */ (e).message}`, { cause: e });
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ people: this.list }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** The person a principal is, made on first sight. @param {import('./identity/index.mjs').Principal} p */
  of(p) {
    const known = this.list.find((x) => x.identities.some((/** @type {any} */ i) => i.issuer === p.issuer && i.subject === p.subject));
    if (known) return known;
    const person = {
      id: `pe_${randomBytes(6).toString('base64url')}`,
      handle: handleFor(p.username, (h) => this.taken(h) || this.list.some((x) => x.handle === h)),
      name: p.name,
      // Whoever runs it owns it: the unix user on a local run. Behind a balancer, the first person in. An open question.
      role: this.mode === 'local' || !this.list.some((x) => x.role === 'owner') ? 'owner' : 'member',
      identities: [{ provider: p.provider, issuer: p.issuer, subject: p.subject }],
      aliases: p.email ? [{ kind: 'email', value: p.email }] : [],
      edited: false,
      createdAt: Date.now(),
    };
    this.list.push(person);
    this.save();
    return person;
  }

  handles() {
    return this.list.map((p) => p.handle);
  }

  /** @param {string} handle */
  byHandle(handle) {
    return this.list.find((p) => p.handle.toLowerCase() === String(handle).toLowerCase());
  }

  /** A person whose seat a script fills, for the demo and the tests. @param {string} name */
  scripted(name) {
    const p = this.of({ provider: 'mock', issuer: 'postbox:mock', subject: name, username: name.split(' ')[0], name });
    if (p.filledBy !== 'mock') {
      Object.assign(p, { filledBy: 'mock', role: 'member' });
      this.save();
    }
    return p;
  }

  /**
   * An entry in a person’s queue, shaped as an agent’s inbox entry is (server/delivery.mjs): what was said, where, by
   * whom, and whether they have read or dismissed it. @param {any} person @param {{ threadId: string, itemId: string, from: string }} e
   */
  enqueue(person, { threadId, itemId, from }) {
    const entry = { id: `en_${randomBytes(6).toString('base64url')}`, threadId, itemId, source: 'mention', from, at: Date.now(), state: 'waiting' };
    person.queue = [...(person.queue ?? []), entry].slice(-QUEUE);
    this.save();
    return entry;
  }

  /** A person reads or dismisses an entry of their own. @param {any} person @param {string} id @param {unknown} state */
  settle(person, id, state) {
    if (state !== 'read' && state !== 'dismissed') throw httpError(422, 'An entry is marked read or dismissed.');
    const entry = (person.queue ?? []).find((/** @type {any} */ e) => e.id === id);
    if (!entry) throw httpError(404, 'That entry isn’t in your queue. It may have been cleared already.');
    entry.state = state;
    this.save();
    return entry;
  }

  /** Writing in a conversation answers what waited for the person there. @param {any} person @param {string} threadId */
  answered(person, threadId) {
    const waiting = (person.queue ?? []).filter((/** @type {any} */ e) => e.threadId === threadId && e.state === 'waiting');
    for (const e of waiting) e.state = 'read';
    if (waiting.length) this.save();
  }

  /** A person changes their own profile, and only theirs. @param {any} person @param {unknown} fields */
  edit(person, fields) {
    let edit;
    try {
      edit = profileEdit(fields);
    } catch (e) {
      throw httpError(422, /** @type {Error} */ (e).message);
    }
    Object.assign(person, edit, { edited: true });
    this.save();
    return person;
  }

  /** What a message keeps of its sender. @param {any} person */
  byline(person) {
    return byline(person, this.list.length);
  }

  /** What the page gets: the viewer’s whole profile, and the others’ public parts. @param {any} me */
  page(me) {
    const { queue = [], ...profile } = me;
    return { me: profile, people: this.list.map(publicPerson), mode: this.mode, queue: queue.filter((/** @type {any} */ e) => e.state === 'waiting') };
  }

  facts() {
    return peopleFacts(this.list);
  }
}
