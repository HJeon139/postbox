// view_app’s browser (designs/architecture/view-app.md, “Agents see their app”): Chromium’s headless shell, the build the pinned
// playwright-core names, downloaded into Postbox’s data folder only after the person agrees (server/view-app/consent.mjs).
// One browser, started on first use and closed after five idle minutes, as the narrator is. Each capture gets a context
// of its own that can only GET Postbox, so it can’t write, mark a thread viewed or reach the network.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const IDLE_MS = 5 * 60 * 1000;
/** How long one capture may take, from a new context to the picture. */
export const CAPTURE_MS = 20000;
/** How long the download may take before Postbox gives up on it. */
const INSTALL_MS = 10 * 60 * 1000;
/** What a download that stopping Postbox ended says. */
export const STOPPED = 'Postbox stopped before the download finished. Call view_app again to be asked again.';
/** How long closing a context or the browser may take before Postbox stops waiting on it. */
const CLOSE_MS = 5000;

/**
 * `promise`, or a rejection saying `what` took too long after `ms`. A hung browser answers nothing, and view_app’s
 * call mustn’t wait on it for good. @template T @param {Promise<T>} promise @param {number} ms @param {string} what
 * @returns {Promise<T>}
 */
function within(promise, ms, what) {
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  const late = new Promise((_, no) => {
    timer = setTimeout(() => no(Object.assign(new Error(`${what} took longer than ${ms / 1000} s.`), { late: true })), ms);
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, late])).finally(() => clearTimeout(timer));
}
/** The window a capture uses when no Postbox tab has reported its own: a 14-inch laptop’s browser (#95’s ruling). */
export const DEFAULT_WINDOW = Object.freeze({ width: 1000, height: 680 });

/** Where playwright-core is installed (an optional dependency), or null. */
function packageDir() {
  try {
    return dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
  } catch {
    // Not installed: an optional dependency that npm skipped. view_app then says so.
    return null;
  }
}

/** The headless shell’s revision, as the pinned playwright-core names it. @param {string} pkg */
function shellRevision(pkg) {
  const { browsers } = JSON.parse(readFileSync(join(pkg, 'browsers.json'), 'utf8'));
  return browsers.find((b) => b.name === 'chromium-headless-shell')?.revision ?? null;
}

/**
 * The headless shell’s executable under `dir`, for the pinned revision, or null when it isn’t downloaded. It’s found
 * by name, two levels down, rather than by a per-platform path: chrome-headless-shell on macOS and Linux, with .exe
 * on Windows. @param {string} dir @param {string} revision
 */
function shellIn(dir, revision) {
  const root = join(dir, `chromium_headless_shell-${revision}`);
  if (!existsSync(root)) return null;
  for (const sub of readdirSync(root)) {
    for (const name of ['chrome-headless-shell', 'chrome-headless-shell.exe']) {
      const exe = join(root, sub, name);
      if (existsSync(exe) && statSync(exe).isFile()) return exe;
    }
  }
  return null;
}

export class AppBrowser {
  /**
   * @param {{ dir: string, spawnImpl?: typeof spawn, load?: () => Promise<any>, pkg?: string|null, captureMs?: number }} opts
   *   dir: Postbox’s own browsers folder, in its data folder; load, pkg and captureMs replace playwright-core and the
   *   limit in tests
   */
  constructor({ dir, spawnImpl = spawn, load = () => import('playwright-core'), pkg = packageDir(), captureMs = CAPTURE_MS }) {
    this.dir = dir;
    this.captureMs = captureMs;
    this.spawn = spawnImpl;
    this.load = load;
    this.pkg = pkg;
    /** @type {Promise<any>|null} */
    this.starting = null;
    /** @type {NodeJS.Timeout|null} */
    this.idle = null;
    /** @type {Promise<{ ok: boolean, message?: string }>|null} */
    this.installing = null;
    /** The installer while it runs, so stopping Postbox stops it too. @type {import('node:child_process').ChildProcess|null} */
    this.installer = null;
    /** Whether Postbox is stopping, which ends a download that’s running. */
    this.stopping = false;
  }

  /** Whether the package is there, and whether its browser is downloaded. @returns {'no-package'|'missing'|'ready'} */
  status() {
    if (!this.pkg) return 'no-package';
    const rev = shellRevision(this.pkg);
    return rev && shellIn(this.dir, rev) ? 'ready' : 'missing';
  }

  /**
   * Downloads the headless shell with Playwright’s own installer, as a child process with an argument array, into
   * Postbox’s folder only. Resolves { ok, message }; never rejects. A second call while one runs shares it.
   */
  install() {
    if (this.installing) return this.installing;
    if (!this.pkg) return Promise.resolve({ ok: false, message: 'playwright-core isn’t installed, so Postbox can’t download its browser.' });
    const cli = join(this.pkg, 'cli.js');
    this.installing = new Promise((resolve) => {
      const child = this.spawn(process.execPath, [cli, 'install', '--only-shell', '--no-progress', 'chromium'], {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: this.dir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.installer = child;
      let err = '';
      child.stderr?.on('data', (d) => {
        err = (err + d).slice(-2000);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_MS);
      timer.unref();
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, message: `The download couldn’t start: ${e.message}` });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0 && this.status() === 'ready') resolve({ ok: true });
        else if (child.killed && signal === 'SIGKILL' && this.stopping) resolve({ ok: false, message: STOPPED });
        else resolve({ ok: false, message: `The download stopped (${signal ?? `exit ${code}`}). ${err.trim().split('\n').pop() ?? ''}`.trim() });
      });
    }).finally(() => {
      this.installing = null;
      this.installer = null;
    });
    return this.installing;
  }

  /** The running browser, started on first use. */
  async browser() {
    this.touch();
    if (!this.starting) {
      const rev = this.pkg ? shellRevision(this.pkg) : null;
      const exe = rev ? shellIn(this.dir, rev) : null;
      if (!exe) throw new Error('Postbox’s browser isn’t downloaded.');
      this.starting = this.load().then(({ chromium }) =>
        chromium.launch({
          executablePath: exe,
          // Its own process for the app’s sandboxed frame, as Chrome gives a person (tools/browser.mjs).
          args: ['--site-per-process'],
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          timeout: CAPTURE_MS,
        }),
      );
      // A browser that failed to start, or closed, is started again next time.
      const forget = () => {
        this.starting = null;
      };
      this.starting.then((b) => b.on('disconnected', forget), forget);
    }
    return this.starting;
  }

  /** Puts off closing an idle browser. */
  touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref();
  }

  /**
   * Closes the browser, if one runs, and stops a download that’s running. The browser’s pipe closing ends the headless
   * shell too, so a close that hangs is given up on after CLOSE_MS.
   */
  async close() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.installer) {
      // Its card says Postbox stopped, before the store closes (server/view-app/consent.mjs).
      this.stopping = true;
      this.installer.kill('SIGKILL');
      await within(Promise.resolve(this.installing), CLOSE_MS, 'Stopping the download').catch(() => {});
    }
    const b = this.starting;
    this.starting = null;
    await within(Promise.resolve(b?.then((x) => x.close())), CLOSE_MS, 'Closing the browser').catch(() => {});
  }

  /**
   * A PNG of one app, rendered by the real page in capture mode (app/js/capture-view.mjs) at the given window and
   * theme, in a conversation `column` px wide, or beside the rail when that’s null. The context aborts every request
   * that isn’t a GET to `origin`. The whole capture has CAPTURE_MS: past that, the browser is closed, as a hung one
   * would hang every later call too, and the next call starts a new one.
   * @param {{ origin: string, threadId: string, itemId: string, width: number, height: number, column?: number|null, theme: 'light'|'dark' }} at
   * @returns {Promise<Buffer>}
   */
  async capture(at) {
    try {
      return await within(this.render(at), this.captureMs, 'Rendering the app');
    } catch (e) {
      if (e.late) await this.close();
      throw e;
    }
  }

  /** The capture itself. @param {Parameters<AppBrowser['capture']>[0]} at @returns {Promise<Buffer>} */
  async render({ origin, threadId, itemId, width, height, column = null, theme }) {
    const browser = await this.browser();
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    try {
      const own = new URL(origin).origin;
      await context.route('**/*', (route) => {
        const r = route.request();
        return r.method() === 'GET' && new URL(r.url()).origin === own ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      const q = new URLSearchParams({ capture: itemId, thread: threadId, ...(column ? { column: String(column) } : {}) });
      await page.goto(`${own}/?nocheck&${q}`, { timeout: CAPTURE_MS });
      await page.waitForSelector('[data-capture="ready"], [data-capture="missing"]', { timeout: CAPTURE_MS });
      if (await page.$('[data-capture="missing"]')) throw new Error('The page couldn’t find that app to show.');
      const png = await page.locator('[data-capture-item]').screenshot({ timeout: CAPTURE_MS, animations: 'disabled' });
      this.touch();
      return png;
    } finally {
      await within(context.close(), CLOSE_MS, 'Closing the page').catch(() => {});
    }
  }
}
