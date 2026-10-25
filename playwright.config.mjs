// The headless browser checks, on Playwright Test (#303, designs/architecture.md, “Browser checks on Playwright
// Test”). Each spec file starts its own Postbox (tests/browser/postbox.mjs); its tests run in order, each in a fresh
// browser context. Files run in parallel, one per worker.
//
//   npx playwright test                             every spec
//   POSTBOX_STREAM_LAG=300 npx playwright test       every server holds its events back 300 ms, as a busy runner can
//   npx playwright test needs-nav --repeat-each=10   a spec ten times, as CI runs one a pull request adds or edits

import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.spec.mjs',
  outputDir: 'test-results',
  // A test.only left in fails CI instead of skipping the rest; a test that passed only on a rerun fails it too.
  forbidOnly: CI,
  failOnFlakyTests: CI,
  retries: 0,
  // 4 at a time on CI’s 4-core runner, as check-all measured (#174).
  workers: CI ? 4 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Beside check-all’s logs, one file per pass. PB_REPORT names another, for a pass that shares one of these
  // settings, as CI’s ten-times pass shares the lag pass’s (#317).
  reporter: CI
    ? [['list'], ['json', { outputFile: process.env.PB_REPORT ?? `check-logs/${process.env.POSTBOX_STREAM_LAG ? 'lag/' : ''}playwright.json` }]]
    : 'list',
  use: {
    ...devices['Desktop Chrome'],
    // Chromium’s own headless mode, the one Chrome ships, not the separate headless shell.
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
});
