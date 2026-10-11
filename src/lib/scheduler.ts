/**
 * scheduler.ts
 *
 * Manages recurring email sync jobs. Fires at UTC-boundary-aligned times.
 */

import { createJob, loadJobs, updateJob, type Job } from './job-store';
import { createRun, updateRun } from './run-store';
import { syncEmails } from './email-sync';
import { isApiMode } from './api-writer';
import {
  computeNextBoundary,
  sincePresetToMs,
  type SincePreset,
} from './since-presets';
import { enqueue } from './scheduler-queue';
import os from 'node:os';

async function reportSync(job: Job, startedAt: string, error: string | null, counts?: object): Promise<void> {
  try {
    const base = process.env.MEMORY_DATABASE_API_URL!.replace(/\/+$/, '');
    const token = process.env.MEMORY_DATABASE_API_WRITE_TOKEN || process.env.MEMORY_DATABASE_API_TOKEN;
    const response = await fetch(`${base}/api/sync-state/${encodeURIComponent(`gmail:${os.hostname()}:${job.id}`)}`, {
      method: 'PUT', headers: {'Content-Type':'application/json',Authorization:`Bearer ${token}`},
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({source:'gmail',last_run_at:new Date().toISOString(),
        ...(!error ? {last_sync_date:startedAt} : {}),error_message:error,
        metadata:{ingestor:'gmail',job:job.name,mailbox:job.mailbox,...counts}}),
    });
    if (!response.ok) console.warn(`[Scheduler] Freshness report failed: HTTP ${response.status}`);
  } catch { console.warn('[Scheduler] Unable to report freshness'); }
}

const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearJobTimer(jobId: string): void {
  const t = jobTimers.get(jobId);
  if (t !== undefined) {
    clearTimeout(t);
    jobTimers.delete(jobId);
  }
}

export type JobRunOverrides = {
  limit?: number;
  sinceMs?: number;
  sincePreset?: Job['sincePreset'];
};

async function executeJob(job: Job, overrides?: JobRunOverrides): Promise<void> {
  if (!isApiMode()) {
    console.error('[Scheduler] No write backend configured (MEMORY_DATABASE_API_URL/TOKEN) — cannot run job.');
    return;
  }

  const now = new Date();
  const runSincePreset = overrides?.sincePreset ?? job.sincePreset;
  const runLimit = overrides?.limit ?? job.limit;

  const overlapPctRaw = Number(process.env.SCHEDULE_SINCE_OVERLAP_PERCENT ?? '10');
  const overlapPct = Number.isFinite(overlapPctRaw) ? Math.min(Math.max(overlapPctRaw, 0), 100) : 10;

  let effectiveSinceMs: number | undefined;
  if (overrides?.sinceMs !== undefined) {
    effectiveSinceMs = overrides.sinceMs;
  } else if (job.lastSyncedAt) {
    // Priority: lastSyncedAt → startDate → sincePreset (legacy) → beginning (0)
    effectiveSinceMs = new Date(job.lastSyncedAt).getTime();
  } else if (job.startDate) {
    effectiveSinceMs = new Date(job.startDate).getTime();
  } else if (runSincePreset && runSincePreset !== 'all') {
    const baseMs = sincePresetToMs(runSincePreset as SincePreset);
    const lookbackMs = Math.round(baseMs * (1 + overlapPct / 100));
    effectiveSinceMs = now.getTime() - lookbackMs;
  } else if (runSincePreset === 'all') {
    effectiveSinceMs = 0;
  }
  // Apply startDate as floor even when lastSyncedAt is set
  if (job.startDate && effectiveSinceMs !== undefined) {
    const startMs = new Date(job.startDate).getTime();
    effectiveSinceMs = Math.max(effectiveSinceMs, startMs);
  }

  const startedAt = now.toISOString();
  await updateJob(job.id, { lastStatus: 'running', lastRunAt: startedAt });

  const run = await createRun({
    jobId: job.id,
    startedAt,
    status: 'running',
    channel: job.mailbox,
    params: {
      limit: runLimit,
      sincePreset: runSincePreset,
      effectiveAfter: effectiveSinceMs !== undefined ? new Date(effectiveSinceMs).toISOString() : undefined,
    },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
  });

  try {
    console.log(
      `[Scheduler] Starting job ${job.id} (${job.name}) — mailbox=${job.mailbox}` +
      (job.cadencePreset ? ` — cadence=${job.cadencePreset}` : '') +
      (runSincePreset ? ` — since=${runSincePreset}` : '')
    );

    const result = await syncEmails({
      mailbox: job.mailbox,
      sinceMs: effectiveSinceMs,
      limit: runLimit,
      verbose: true,
    });

    if (!result.complete) throw new Error('Sync limit omitted older messages; checkpoint unchanged. Use limit 0 for a complete incremental sync.');
    const finishedAt = new Date().toISOString();
    // Start time closes the race with messages arriving while this run is active.
    await updateJob(job.id, { lastStatus: 'success', lastRunAt: finishedAt, lastSyncedAt: startedAt });
    await updateRun(run.runId, {
      finishedAt,
      status: 'success',
      fetchedCount: result.fetched,
      insertedCount: result.inserted,
      updatedCount: result.updated,
      skippedCount: result.skipped,
      attachmentsSeen: result.attachmentsSeen,
      attachmentsIngested: result.attachmentsIngested,
    });

    console.log(
      `[Scheduler] Job ${job.id} done — fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated}`
    );
    await reportSync(job, startedAt, null, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Scheduler] Job ${job.id} (${job.name}) failed: ${message}`);
    await updateJob(job.id, { lastStatus: 'error' });
    await updateRun(run.runId, {
      finishedAt: new Date().toISOString(),
      status: 'error',
      error: message,
    });
    await reportSync(job, startedAt, message);
  }
}

export function scheduleJob(job: Job): void {
  clearJobTimer(job.id);
  if (!job.enabled) return;

  let delayMs: number;

  if (job.cadencePreset) {
    const nextBoundary = computeNextBoundary(job.cadencePreset);
    delayMs = Math.max(0, nextBoundary.getTime() - Date.now());
    console.log(
      `[Scheduler] Job ${job.id} (${job.name}) — cadence=${job.cadencePreset}` +
      ` next boundary: ${nextBoundary.toISOString()} (in ${Math.round(delayMs / 1000)}s)`
    );
  } else if (job.lastRunAt) {
    const intervalMs = job.intervalMinutes * 60 * 1000;
    const lastRun = new Date(job.lastRunAt).getTime();
    delayMs = Math.max(0, lastRun + intervalMs - Date.now());
    console.log(`[Scheduler] Job ${job.id} (${job.name}) next run in ${Math.round(delayMs / 1000)}s`);
  } else {
    delayMs = 5_000;
    console.log(`[Scheduler] Job ${job.id} (${job.name}) first run in ${delayMs / 1000}s`);
  }

  const timer = setTimeout(async () => {
    jobTimers.delete(job.id);

    const jobs = await loadJobs();
    const current = jobs.find(j => j.id === job.id);

    if (!current) {
      console.log(`[Scheduler] Job ${job.id} no longer exists — dropping.`);
      return;
    }

    if (!current.enabled) {
      console.log(`[Scheduler] Job ${job.id} (${current.name}) disabled — not running.`);
      return;
    }

    const { enqueued } = enqueue(current.id, current.name, () => executeJob(current));
    if (!enqueued) {
      console.log(`[Scheduler] Job ${current.id} (${current.name}) already queued/running — skipping.`);
    }

    scheduleJob(current);
  }, delayMs);

  jobTimers.set(job.id, timer);
}

export function unscheduleJob(jobId: string): void {
  clearJobTimer(jobId);
}

export function runJobNow(job: Job, overrides?: JobRunOverrides): Promise<void> {
  clearJobTimer(job.id);
  const { promise } = enqueue(job.id, job.name, () => executeJob(job, overrides));
  if (job.enabled) scheduleJob(job);
  return promise;
}

async function ensureDefaultJob(jobs: Job[]): Promise<Job[]> {
  if (jobs.length > 0) return jobs;
  if ((process.env.DEFAULT_SYNC_JOB_ENABLED ?? 'true').toLowerCase() === 'false') {
    console.log('[Scheduler] No jobs configured; DEFAULT_SYNC_JOB_ENABLED=false so not creating one.');
    return jobs;
  }

  const mailbox = process.env.DEFAULT_SYNC_MAILBOX ?? '[Gmail]/All Mail';
  const cadencePreset = (process.env.DEFAULT_SYNC_CADENCE ?? '1h') as Job['cadencePreset'];
  const sincePreset = (process.env.DEFAULT_SYNC_SINCE ?? '1d') as Job['sincePreset'];
  const limit = Number(process.env.DEFAULT_SYNC_LIMIT ?? '0');
  const intervalMinutes = Number(process.env.DEFAULT_SYNC_INTERVAL_MINUTES ?? '60');

  const job = await createJob({
    name: process.env.DEFAULT_SYNC_JOB_NAME ?? 'Hourly Gmail sync',
    mailbox,
    cadencePreset,
    sincePreset,
    intervalMinutes,
    limit: Number.isFinite(limit) && limit >= 0 ? limit : 0,
    enabled: true,
  });
  console.log(
    `[Scheduler] Created default job ${job.id} (${job.name}) — mailbox=${job.mailbox}` +
    (job.cadencePreset ? ` cadence=${job.cadencePreset}` : '') +
    (job.sincePreset ? ` since=${job.sincePreset}` : '')
  );
  return [job];
}

export async function startScheduler(): Promise<void> {
  const jobs = await ensureDefaultJob(await loadJobs());
  const enabledJobs = jobs.filter(j => j.enabled);
  console.log(`[Scheduler] Starting — ${jobs.length} total jobs, ${enabledJobs.length} enabled.`);
  for (const job of enabledJobs) {
    scheduleJob(job);
  }

  if ((process.env.DEFAULT_SYNC_RUN_ON_START ?? 'true').toLowerCase() !== 'false') {
    for (const job of enabledJobs) {
      console.log(`[Scheduler] Enqueueing startup run for ${job.id} (${job.name}).`);
      runJobNow(job).catch((err: unknown) => console.error(`[Scheduler] startup run failed:`, err));
    }
  }
}
