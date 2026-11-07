import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { retryDelay } from './backoff.mjs';
import { LEASE_MS, MAX_ATTEMPTS } from './config.mjs';

const FILE = 'data/jobs.json';

export function load() {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
}

function save(jobs) {
  mkdirSync('data', { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(jobs, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
}

function change(id, fn) {
  const jobs = load();
  const job = jobs.find((j) => j.id === id);
  if (job) fn(job);
  save(jobs);
  return job;
}

/** Adds a job unless one with the same id is already there. */
export function enqueue(job) {
  const jobs = load();
  if (jobs.some((j) => j.id === job.id)) return false;
  jobs.push({ state: 'queued', attempts: 0, owner: null, leaseUntil: null, ...job });
  save(jobs);
  return true;
}

/** The first queued job that’s due, now leased to this worker. */
export function claim(worker, now) {
  const jobs = load();
  const job = jobs.find((j) => j.state === 'queued' && j.runAt <= now);
  if (!job) return null;
  Object.assign(job, { state: 'running', owner: worker, leaseUntil: now + LEASE_MS, attempts: job.attempts + 1 });
  save(jobs);
  return job;
}

export function complete(id) {
  return change(id, (job) => Object.assign(job, { state: 'done', owner: null, leaseUntil: null }));
}

export function fail(id, error, now) {
  return change(id, (job) => {
    job.lastError = String(error);
    job.owner = null;
    job.leaseUntil = null;
    if (job.attempts >= MAX_ATTEMPTS) job.state = 'dead';
    else Object.assign(job, { state: 'queued', runAt: now + retryDelay(job.attempts) });
  });
}

/** Puts back every running job whose lease ran out, as if its worker had died. */
export function releaseExpired(now) {
  const jobs = load();
  const expired = jobs.filter((j) => j.state === 'running' && j.leaseUntil < now);
  for (const job of expired) Object.assign(job, { state: 'queued', owner: null, leaseUntil: null, runAt: now });
  if (expired.length) save(jobs);
  return expired.map((j) => j.id);
}
