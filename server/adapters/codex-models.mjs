// The codex binary, its version, and the models this sign-in offers (server/adapters/codex.mjs runs it).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const findCodex = (env = process.env) => env.POSTBOX_CODEX_BIN || 'codex';

function probe(bin, args, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '';
    /** @type {any} */
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (chunk) => {
      out = (out + chunk).slice(-300_000);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
}
export async function codexVersion(bin = findCodex()) {
  const out = await probe(bin, ['--version']);
  return out?.match(/(?:codex\s+)?([\w.-]+)$/i)?.[1] ?? null;
}
export async function codexModels(bin = findCodex()) {
  // The documented app-server model/list method returns the local account's picker-visible catalog.
  return new Promise((resolve) => {
    /** @type {any} */
    let child;
    try {
      child = spawn(bin, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve([]);
      return;
    }
    const rl = createInterface({ input: child.stdout });
    let id = 1;
    let timer;
    const finish = (models) => {
      clearTimeout(timer);
      child.kill('SIGTERM');
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
