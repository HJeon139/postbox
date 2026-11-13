// The models a harness’s CLI lists, asked of the CLI itself, which runs no model: Claude Code’s, Kiro’s and Codex’s.
// Here, so a host’s daemon can run them too (install-bundle.mjs ships only shared/ and server/remote/host/); the
// laptop’s adapters run the same code.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { claudeModelIds, kiroModelIds } from '../../../shared/model-ids.mjs';
import { stopProbe } from './probe-stop.mjs';

/** How long a listing may take before it counts as failed. */
export const LIST_TIMEOUT_MS = 15_000;

/**
 * Settings for a listing, passed with --settings over the person’s own: no hooks run, so a listing never runs their
 * SessionStart hooks, up to once a minute for each open sheet. Hooks an organization manages still run.
 */
const LISTING_SETTINGS = JSON.stringify({ disableAllHooks: true });

/**
 * Claude Code’s models: `claude -p` in stream-json, asked with an initialize request and nothing else, then stopped
 * (stopProbe). Empty if it fails.
 * @param {string} bin @param {{ spawnImpl?: typeof spawn, timeoutMs?: number, graceMs?: number }} [opts]
 *   timeoutMs: how long it may take; graceMs: how long it has to close after SIGTERM
 * @returns {Promise<string[]>}
 */
export function claudeModels(bin, { spawnImpl = spawn, timeoutMs = LIST_TIMEOUT_MS, graceMs } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
    args.push('--settings', LISTING_SETTINGS);
    /** @type {any} */
    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve([]);
      return;
    }
    const lines = createInterface({ input: child.stdout });
    let done = false;
    // Once: stopping the CLI closes it, and its close comes back here.
    const finish = (/** @type {string[]} */ models) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      stopProbe(child, graceMs);
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    timer.unref?.();
    lines.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // Not one of the stream’s JSON lines: the answer is a line of its own.
      }
      if (msg?.type === 'control_response' && msg.response?.request_id === 'models')
        finish(msg.response.subtype === 'success' ? claudeModelIds(msg.response.response?.models) : []);
    });
    child.on('error', () => finish([]));
    child.on('close', () => finish([]));
    child.stdin.on('error', () => {}); // A CLI that exited first closes stdin; its close event answers.
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`);
  });
}

/**
 * The models this Kiro sign-in offers, in Postbox’s spelling, for the model field’s suggestions: Claude’s, and the
 * others Kiro runs (GPT, DeepSeek, GLM and more), which is half the point of a second backend (#117). Read from
 * `kiro-cli chat --list-models --format json` ({ models: [{ model_id }] }), which runs no model. Empty if it fails.
 * @returns {Promise<string[]>}
 */
export function kiroModels(bin, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawnImpl(bin, ['chat', '--list-models', '--format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => stopProbe(p), 15000);
    p.stdout.on('data', (d) => {
      out = (out + d).slice(-200_000);
    });
    p.on('error', () => resolve([]));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? kiroModelIds(out) : []);
    });
  });
}

export async function codexModels(bin, { spawnImpl = spawn } = {}) {
  // The documented app-server model/list method returns the local account's picker-visible catalog.
  return new Promise((resolve) => {
    /** @type {any} */
    let child;
    try {
      child = spawnImpl(bin, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve([]);
      return;
    }
    const rl = createInterface({ input: child.stdout });
    let id = 1;
    let timer;
    const finish = (models) => {
      clearTimeout(timer);
      stopProbe(child);
      rl.close();
      resolve(models);
    };
    timer = setTimeout(() => finish([]), 15000);
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1 && msg.result) {
        child.stdin.write(`${JSON.stringify({ id: ++id, method: 'model/list', params: { limit: 100, includeHidden: false } })}\n`);
      } else if (msg.id === 2) {
        clearTimeout(timer);
        const models = (msg.result?.data ?? []).map((m) => m?.id ?? m?.model).filter((m) => typeof m === 'string' && /^[\w.-]{1,80}$/.test(m));
        finish([...new Set(models)].slice(0, 60));
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish([]);
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'postbox', title: 'Postbox', version: '0.2.0' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  });
}
