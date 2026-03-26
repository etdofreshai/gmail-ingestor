/**
 * sync-router.ts
 *
 * Express routes for manual sync, job management, and run history.
 */

import { Router, type Request, type Response } from 'express';
import { syncEmails } from './email-sync';
import { isApiMode } from './api-writer';
import {
  loadJobs,
  createJob,
  getJob,
  updateJob,
  deleteJob,
} from './job-store';
import { getRecentRuns, createRun, updateRun } from './run-store';
import { scheduleJob, unscheduleJob, runJobNow } from './scheduler';
import { enqueue, getQueueStatus } from './scheduler-queue';
import {
  isSincePreset,
  isCadencePreset,
  resolveSincePresetToMs,
  CADENCE_PRESET_MINUTES,
  type SincePreset,
  type CadencePreset,
} from './since-presets';

const router = Router();

// ── Current sync status (simple in-memory flag) ──────────────────────────────

let currentSyncStatus: 'idle' | 'running' = 'idle';

// ── API: manual sync ──────────────────────────────────────────────────────────

router.post('/sync', async (req: Request, res: Response) => {
  const {
    mailbox: mailboxRaw,
    limit: limitRaw,
    sincePreset: sincePresetRaw,
  } = req.body as {
    mailbox?: string;
    limit?: string | number;
    sincePreset?: string;
  };

  const mailbox = (mailboxRaw ?? '[Gmail]/All Mail').trim();

  const sincePreset: SincePreset | undefined =
    sincePresetRaw && isSincePreset(sincePresetRaw) ? sincePresetRaw : undefined;
  if (sincePresetRaw && !sincePreset) {
    res.status(400).json({ error: `Invalid sincePreset '${sincePresetRaw}'.` });
    return;
  }

  if (!isApiMode()) {
    res.status(500).json({ error: 'No write backend configured (set MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN).' });
    return;
  }

  const parsedLimit = limitRaw !== undefined && limitRaw !== '' ? parseInt(String(limitRaw), 10) : undefined;
  const now = new Date();
  const effectiveSinceMs = sincePreset ? resolveSincePresetToMs(sincePreset, now) : undefined;

  const startedAt = now.toISOString();

  const run = await createRun({
    startedAt,
    status: 'queued',
    channel: mailbox,
    params: {
      limit: parsedLimit,
      sincePreset,
      effectiveAfter: effectiveSinceMs !== undefined ? new Date(effectiveSinceMs).toISOString() : undefined,
    },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
    attachmentsIngested: 0,
  });

  let syncError: string | null = null;
  let syncResult: { fetched: number; inserted: number; updated: number; skipped: number; attachmentsSeen: number; attachmentsIngested: number } | null = null;

  const { promise } = enqueue(`manual:${run.runId}`, `manual sync ${mailbox}`, async () => {
    currentSyncStatus = 'running';
    await updateRun(run.runId, { status: 'running' });
    try {
      const result = await syncEmails({
        mailbox,
        sinceMs: effectiveSinceMs,
        limit: parsedLimit,
        verbose: true,
      });
      const finishedAt = new Date().toISOString();
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
      syncResult = result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await updateRun(run.runId, { finishedAt: new Date().toISOString(), status: 'error', error: message });
      syncError = message;
      throw err;
    } finally {
      currentSyncStatus = 'idle';
    }
  });

  await promise.catch(() => {});

  if (syncError) {
    res.status(500).json({ error: syncError, runId: run.runId });
    return;
  }

  res.json({
    success: true,
    runId: run.runId,
    mailbox,
    sincePreset: sincePreset ?? null,
    effectiveSinceMs: effectiveSinceMs ?? null,
    ...(syncResult ?? {}),
  });
});

// ── API: sync status ──────────────────────────────────────────────────────────

router.get('/sync/status', (_req: Request, res: Response) => {
  res.json({
    status: currentSyncStatus,
    queue: getQueueStatus(),
  });
});

// ── API: runs ─────────────────────────────────────────────────────────────────

router.get('/runs', async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
  const runs = await getRecentRuns(Math.min(Math.max(1, limit), 200));
  res.json(runs);
});

// ── API: jobs ─────────────────────────────────────────────────────────────────

router.get('/jobs', async (_req: Request, res: Response) => {
  const jobs = await loadJobs();
  res.json(jobs);
});

router.post('/jobs', async (req: Request, res: Response) => {
  const {
    name,
    mailbox: mailboxRaw,
    limit: limitRaw,
    sincePreset: sincePresetRaw,
    cadencePreset: cadencePresetRaw,
    intervalMinutes: intervalMinutesRaw,
    enabled,
  } = req.body as {
    name?: string;
    mailbox?: string;
    limit?: number;
    sincePreset?: string;
    cadencePreset?: string;
    intervalMinutes?: number;
    enabled?: boolean;
  };

  const mailbox = (mailboxRaw ?? '[Gmail]/All Mail').trim();

  const cadencePreset: CadencePreset | undefined =
    cadencePresetRaw && isCadencePreset(cadencePresetRaw) ? cadencePresetRaw : undefined;
  if (cadencePresetRaw && !cadencePreset) {
    res.status(400).json({ error: `Invalid cadencePreset '${cadencePresetRaw}'.` });
    return;
  }

  const intervalMinutes = cadencePreset
    ? CADENCE_PRESET_MINUTES[cadencePreset]
    : (intervalMinutesRaw !== undefined && Number(intervalMinutesRaw) > 0 ? Number(intervalMinutesRaw) : 1440);

  const sincePreset: SincePreset | undefined =
    sincePresetRaw && isSincePreset(sincePresetRaw) ? sincePresetRaw : undefined;
  if (sincePresetRaw && !sincePreset) {
    res.status(400).json({ error: `Invalid sincePreset '${sincePresetRaw}'.` });
    return;
  }

  const effectiveSincePreset: SincePreset | undefined = sincePreset ?? (cadencePreset as SincePreset | undefined);

  const jobName = (name ?? '').trim() || `Sync ${mailbox} every ${intervalMinutes}m`;

  const job = await createJob({
    name: jobName,
    mailbox,
    limit: limitRaw !== undefined ? Number(limitRaw) : undefined,
    sincePreset: effectiveSincePreset,
    cadencePreset,
    intervalMinutes,
    enabled: enabled !== false,
  });

  if (job.enabled) scheduleJob(job);
  res.status(201).json(job);
});

router.post('/jobs/:id/run', async (req: Request, res: Response) => {
  const job = await getJob(String(req.params.id));
  if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }
  runJobNow(job).catch((err: unknown) => console.error(`[API] runJobNow error:`, err));
  res.json({ success: true, message: 'Job enqueued. Check /api/runs for result.' });
});

router.post('/jobs/:id/run-all', async (req: Request, res: Response) => {
  const job = await getJob(String(req.params.id));
  if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }
  runJobNow(job, { sincePreset: 'all', limit: undefined }).catch((err: unknown) =>
    console.error(`[API] run-all error:`, err)
  );
  res.json({ success: true, message: 'Run-all enqueued. Check /api/runs for progress.' });
});

router.get('/scheduler/status', (_req: Request, res: Response) => {
  res.json(getQueueStatus());
});

router.patch('/jobs/:id', async (req: Request, res: Response) => {
  const {
    name,
    mailbox: mailboxRaw,
    limit: limitRaw,
    sincePreset: sincePresetRaw,
    cadencePreset: cadencePresetRaw,
    intervalMinutes: intervalMinutesRaw,
    enabled,
    startDate,
    lastSyncedAt,
  } = req.body as {
    name?: string;
    mailbox?: string;
    limit?: number | null;
    sincePreset?: string | null;
    cadencePreset?: string | null;
    intervalMinutes?: number;
    enabled?: boolean;
    startDate?: string | null;
    lastSyncedAt?: string | null;
  };

  const jobId = String(req.params.id);
  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = String(name).trim();
  if (mailboxRaw !== undefined) patch.mailbox = String(mailboxRaw).trim();
  if (limitRaw !== undefined) patch.limit = limitRaw === null ? undefined : Number(limitRaw);
  if (enabled !== undefined) patch.enabled = Boolean(enabled);

  if (cadencePresetRaw !== undefined) {
    if (cadencePresetRaw === null || cadencePresetRaw === '') {
      patch.cadencePreset = undefined;
    } else if (isCadencePreset(cadencePresetRaw)) {
      patch.cadencePreset = cadencePresetRaw;
      patch.intervalMinutes = CADENCE_PRESET_MINUTES[cadencePresetRaw];
    } else {
      res.status(400).json({ error: `Invalid cadencePreset '${cadencePresetRaw}'.` });
      return;
    }
  } else if (intervalMinutesRaw !== undefined) {
    patch.intervalMinutes = Math.max(1, Number(intervalMinutesRaw));
  }

  if (sincePresetRaw !== undefined) {
    if (sincePresetRaw === null || sincePresetRaw === '') {
      patch.sincePreset = undefined;
    } else if (isSincePreset(sincePresetRaw)) {
      patch.sincePreset = sincePresetRaw;
    } else {
      res.status(400).json({ error: `Invalid sincePreset '${sincePresetRaw}'.` });
      return;
    }
  }

  if (startDate !== undefined) {
    patch.startDate = startDate === null || startDate === '' ? undefined : String(startDate).trim() || undefined;
  }
  if (lastSyncedAt !== undefined) {
    patch.lastSyncedAt = lastSyncedAt === null || lastSyncedAt === '' ? undefined : String(lastSyncedAt).trim() || undefined;
  }

  const updated = await updateJob(jobId, patch as Parameters<typeof updateJob>[1]);
  if (!updated) { res.status(404).json({ error: 'Job not found.' }); return; }

  if (updated.enabled) scheduleJob(updated);
  else unscheduleJob(updated.id);

  res.json(updated);
});

router.post('/jobs/:id/reset-sync', async (req: Request, res: Response) => {
  const jobId = String(req.params.id);
  const job = await updateJob(jobId, { lastSyncedAt: undefined } as Parameters<typeof updateJob>[1]);
  if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }
  res.json(job);
});

router.delete('/jobs/:id', async (req: Request, res: Response) => {
  const delId = String(req.params.id);
  unscheduleJob(delId);
  const ok = await deleteJob(delId);
  if (!ok) { res.status(404).json({ error: 'Job not found.' }); return; }
  res.json({ success: true });
});

export default router;
