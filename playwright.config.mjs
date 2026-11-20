// The headless browser checks, on Playwright Test (#303, designs/architecture/browser-checks.md, “Browser checks on Playwright
// Test”). Each spec file starts its own Postbox (tests/browser/postbox.mjs); its tests run in order, each in a fresh
// browser context. Files run in parallel, one per worker.
//
//   npx playwright test                             every spec
//   POSTBOX_STREAM_LAG=300 npx playwright test       every server holds its events back 300 ms, as a busy runner can

import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.spec.mjs',
  // Waits for one of this machine’s heavy-suite slots, so agents’ worktrees don’t all run a suite at once.
  globalSetup: './tests/browser/heavy-slot.mjs',
  outputDir: 'test-results',
  // A test.only left in fails CI instead of skipping the rest; a test that passed only on a rerun fails it too.
  forbidOnly: CI,
  failOnFlakyTests: CI,
  retries: 0,
  // 4 at a time, on CI’s 4-core runner as the old headless runner measured there (#174), and locally too (#1532): each
  // worker runs its own Postbox and Chromium, and Playwright’s default, half the cores, starved them on a 12-core Mac. A
  // page streaming eight agents applied events 2–3 s after they were emitted at 6 workers, against 150 ms alone or at 4,
  // and specs’ 5 s waits timed out. `npx playwright test --workers=<n>` still overrides it.
  workers: 4,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // In check-logs/, one file per pass.
  reporter: CI ? [['list'], ['json', { outputFile: `check-logs/${process.env.POSTBOX_STREAM_LAG ? 'lag/' : ''}playwright.json` }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    // Chromium’s own headless mode, the one Chrome ships, not the separate headless shell.
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
});
