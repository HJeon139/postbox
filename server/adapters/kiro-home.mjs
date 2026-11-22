// The Kiro home a turn runs with, moved from kiro-cli.mjs unchanged.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { setupOf } from './setup.mjs';

/** The Kiro home a persona runs with: yours (KIRO_HOME, else ~/.kiro), or Postbox’s own when Isolated. */
export const kiroHomeFor = (persona, { isolatedHome, env = process.env, home = homedir() }) =>
  setupOf(persona).usesHostSetup ? env.KIRO_HOME || join(home, '.kiro') : isolatedHome;
