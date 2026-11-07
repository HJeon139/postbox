// The Kiro CLI’s arguments for one turn, and the Kiro home it runs with, moved out of kiro-cli.mjs.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { kiroModel } from './kiro-cli-models.mjs';
import { effortOf, modelOf, setupOf } from './setup.mjs';

/**
 * The CLI arguments for one turn. Pure, so the tests can check them.
 * @param {{ persona: any, agent: string, sessionId?: string|null, prompt: string, stdin?: boolean }} turn
 */
export function kiroArgs({ persona, agent, sessionId = null, prompt, stdin = false }) {
  const { usesHostSetup } = setupOf(persona);
  return [
    'chat',
    '--agent-engine',
    'v3',
    '--output-format',
    'stream-json',
    '--agent',
    agent,
    // Both always passed: left out, Kiro’s own settings would decide (#60).
    '--model',
    kiroModel(modelOf(persona)),
    '--effort',
    effortOf(persona),
    ...(sessionId ? ['--resume-id', sessionId] : []),
    ...(persona?.permissionMode === 'bypass' ? ['--trust-all-tools'] : []),
    // Isolated loads Postbox’s server only, so a turn without it fails rather than runs blind. Your own servers
    // aren’t held to that: one that doesn’t start shouldn’t stop every turn.
    ...(usesHostSetup ? [] : ['--require-mcp-startup']),
    ...(stdin ? ['--no-interactive'] : ['--', prompt]),
  ];
}

/** The Kiro home a persona runs with: yours (KIRO_HOME, else ~/.kiro), or Postbox’s own when Isolated. */
export const kiroHomeFor = (persona, { isolatedHome, env = process.env, home = homedir() }) =>
  setupOf(persona).usesHostSetup ? env.KIRO_HOME || join(home, '.kiro') : isolatedHome;
