// Rooms for the queue’s browser specs (#1456): one agent held busy in a turn, so what’s sent to it waits in its queue,
// and the page’s requests and frames held when a spec needs to land something between them.
import { expect } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { synced } from './postbox.mjs';

/** Conversations on one spec file’s Postbox: `use` it in beforeAll, after startPostbox, and `stop` it in afterAll. */
export class QueueRooms {
  /** @param {string} name  the spec’s name, for its conversations’ titles */
  constructor(name) {
    this.name = name;
    /** @type {any} */
    this.app = null;
    this.holds = new Set();
    /** @type {Map<string, () => void>} each held agent’s turn, by session, to let go */
    this.releases = new Map();
    this.count = 0;
  }

  /** Installs a scripted Claude Code agent that holds each first turn open until it’s let go. @param {any} app */
  use(app) {
    this.app = app;
    arrange.withAdapter(app.rt, {
      name: 'claude-code',
      folderFor: async () => app.root,
      deliver: async (session, _given, ctx) => {
        if (this.holds.delete(session.id))
          await new Promise((resolve) => {
            this.releases.set(session.id, resolve);
            ctx.signal.addEventListener('abort', resolve, { once: true });
          });
        ctx.text('Done.');
      },
    });
  }

  stop() {
    for (const release of this.releases.values()) release();
  }

  /** A conversation with one agent busy in a turn held open, any others idle, and the page on it. @param {string[]} [others] */
  async busyRoom(page, others = []) {
    const { app } = this;
    const n = ++this.count;
    const personas = ['writer', ...others].map((handle) => app.rt.createPersona({ handle: `${handle}-${n}`, backend: 'claude-code' }));
    const projectId = Object.keys(app.store.state.projects)[0];
    const thread = app.rt.createThread({ projectId, title: `${this.name} ${n}`, personaIds: personas.map((p) => p.id) });
    const [worker, ...senders] = arrange.sessionsIn(app.rt, thread.id);
    this.holds.add(worker.id);
    await page.goto(`${app.origin}/#/t/${thread.id}`);
    await synced(page, app);
    app.rt.sendMessage(thread.id, { text: `@${worker.handle} start the long work` });
    await expect.poll(() => this.releases.has(worker.id)).toBe(true);
    return { thread, worker, senders };
  }

  /** Lines in the conversation: enough before and after an item that a page opened on it loads neither end with it (#1155). */
  lines(r, from, n = 250) {
    for (let i = from; i < from + n; i++) arrange.post(this.app.rt, r.thread.id, { kind: 'user', text: `Line ${i}`, attachments: [], to: [] });
  }

  /** Opens the page on the conversation again, so it holds only its first and latest items. */
  async reopen(page) {
    await page.reload();
    await synced(page, this.app);
  }

  /**
   * A conversation with this many of the person’s messages queued, none of which the page has loaded. The page is away
   * while they’re posted and opens the conversation once they are: hearing the 650 or so events one by one cost 8 to
   * 11 s with the CPU throttled 4×, and took two tests past their 30 s on CI’s slower shard (#1473).
   */
  async longQueue(page, n) {
    const r = await this.busyRoom(page);
    await page.goto('about:blank');
    this.lines(r, 0);
    for (let i = 0; i < n; i++) this.app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} queued ${i}` });
    this.lines(r, 250);
    await page.goto(`${this.app.origin}/#/t/${r.thread.id}`);
    await synced(page, this.app);
    return r;
  }

  /** Confirms a card the worker shows, so the answer waits in its queue. */
  async answerCard(r) {
    const confirm = {
      id: 'frames',
      type: 'confirm',
      version: 1,
      fallback: 'Delete the frames?',
      title: 'Delete the video frames?',
      statement: 'Delete the **23** untracked frames?',
      confirmLabel: 'Delete',
    };
    const said = await this.app.rt.toolsFor(r.worker.id).show_block({ block: confirm });
    expect(said.ok, said.message).toBe(true);
    const card = this.app.store.items(r.thread.id).find((x) => x.kind === 'block' && x.block.id === 'frames');
    this.app.rt.act(r.thread.id, card.id, 'confirm', {});
  }
}

/** The worker’s queue, opened from its row in the agents list. */
export async function openQueue(page, r) {
  await page
    .locator('.agent-row')
    .filter({ hasText: r.worker.handle })
    .getByRole('button', { name: /queued for/ })
    .click();
  return page.getByRole('dialog', { name: new RegExp(`queued for ${r.worker.handle}`) });
}

/** Holds the queue’s item requests until the test lets them go, and counts each by the item it asks for. */
export async function holdItemRequests(page) {
  const asked = new Map();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(/\/items\?around=/, async (route) => {
    const id = new URL(route.request().url()).searchParams.get('around');
    asked.set(id, (asked.get(id) ?? 0) + 1);
    await gate;
    await route.continue();
  });
  return { asked, release: () => release() };
}

/** Installed before the page loads: animation frames asked for while held wait until let go. */
function installFrameHold() {
  const hold = { on: false, queue: new Map(), n: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    if (!hold.on) return raf(cb);
    hold.n += 1;
    hold.queue.set(-hold.n, cb);
    return -hold.n;
  };
  window.cancelAnimationFrame = (id) => {
    if (!hold.queue.delete(id)) caf(id);
  };
  Object.assign(window, { frameHold: hold });
}

/**
 * Holds the page’s animation frames from when the test says until it lets them go, so a change can land between a
 * frame being asked for and its paint. Call it before the page loads.
 */
export async function frameHold(page) {
  await page.addInitScript(installFrameHold);
  const set = (on) =>
    page.evaluate((on) => {
      const hold = /** @type {any} */ (window).frameHold;
      hold.on = on;
      if (on) return;
      const waiting = [...hold.queue.values()];
      hold.queue.clear();
      for (const cb of waiting) cb(performance.now());
    }, on);
  return {
    hold: () => set(true),
    release: () => set(false),
    waiting: () => page.evaluate(() => /** @type {any} */ (window).frameHold.queue.size),
  };
}
