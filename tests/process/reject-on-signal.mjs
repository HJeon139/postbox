// Preloaded into a Postbox server (node --import) by tests/process/unhandled-rejection.test.mjs: on SIGUSR2, an async
// timer callback throws, as a persona delete’s purge did in PR #496, and nothing awaits its promise (#510). On SIGUSR1
// would be the inspector, so it’s SIGUSR2.

process.on('SIGUSR2', () => {
  setTimeout(async () => {
    throw new Error('A timer callback failed: the #510 test’s rejection.');
  }, 0);
});
