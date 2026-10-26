import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notInstalled } from './process/chrome.mjs';

// What Playwright 1.64 threw, with its Chromium not installed (PLAYWRIGHT_BROWSERS_PATH an empty folder), and with
// it installed but unable to start.
const MISSING = new Error(
  "browserType.launch: Executable doesn't exist at /tmp/no-browsers/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell\n╔════╗",
);
const BROKEN = new Error(
  'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n<launching> /Users/me/Library/Caches/ms-playwright/…',
);

test('the process tests skip when Playwright’s Chromium isn’t installed, and say how to install it', () => {
  assert.match(notInstalled(MISSING) ?? '', /isn’t installed \(npx playwright install chromium downloads it\): browserType\.launch: Executable doesn't exist/);
  assert.match(notInstalled(new Error('spawn /opt/chrome ENOENT')) ?? '', /isn’t installed/);
});

test('they fail, not skip, when it’s installed but won’t start: a new revision or a missing system library', () => {
  assert.equal(notInstalled(BROKEN), null);
  assert.equal(notInstalled(new Error('browserType.launch: Timeout 45000ms exceeded.')), null);
  assert.equal(notInstalled(new Error('error while loading shared libraries: libnss3.so: cannot open shared object file')), null);
});
