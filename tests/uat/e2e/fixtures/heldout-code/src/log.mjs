import { appendFileSync, mkdirSync } from 'node:fs';

export function log(line) {
  mkdirSync('logs', { recursive: true });
  appendFileSync('logs/worker.log', `${new Date().toISOString()} ${line}\n`);
}
