import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SincePreset, CadencePreset } from './since-presets';

export interface Job {
  id: string;
  name: string;
  /** IMAP mailbox to sync (e.g. '[Gmail]/All Mail') */
  mailbox: string;
  limit?: number;
  sincePreset?: SincePreset;
  cadencePreset?: CadencePreset;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: 'success' | 'error' | 'running';
}

const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), '.data');

const DATA_DIR = path.join(DATA_ROOT, 'jobs');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadJobs(): Promise<Job[]> {
  try {
    const raw = await fs.readFile(JOBS_FILE, 'utf8');
    return JSON.parse(raw) as Job[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[job-store] Failed to read/parse jobs: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
}

async function saveJobs(jobs: Job[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf8');
}

export async function createJob(
  data: Omit<Job, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Job> {
  const jobs = await loadJobs();
  const now = new Date().toISOString();
  const job: Job = { ...data, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  jobs.push(job);
  await saveJobs(jobs);
  return job;
}

export async function getJob(id: string): Promise<Job | null> {
  const jobs = await loadJobs();
  return jobs.find(j => j.id === id) ?? null;
}

export async function updateJob(
  id: string,
  patch: Partial<Omit<Job, 'id' | 'createdAt'>>
): Promise<Job | null> {
  const jobs = await loadJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return null;
  jobs[idx] = { ...jobs[idx], ...patch, updatedAt: new Date().toISOString() };
  await saveJobs(jobs);
  return jobs[idx];
}

export async function deleteJob(id: string): Promise<boolean> {
  const jobs = await loadJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  await saveJobs(jobs);
  return true;
}
