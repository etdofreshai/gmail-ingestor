import path from 'path';
import express from 'express';
import { config } from './config';
import mailboxesRouter from './routes/mailboxes';
import emailsRouter from './routes/emails';
import syncRouter from './lib/sync-router';
import { startScheduler } from './lib/scheduler';

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/help', (_req, res) => {
  res.json({
    name: 'OpenClaw Email Ingestor API',
    description: 'API for browsing, searching, and syncing Gmail via IMAP. All endpoints except /api/health and /api/help require a Bearer token in the Authorization header.',
    auth: {
      type: 'Bearer',
      header: 'Authorization: Bearer <API_BEARER_TOKEN>',
      note: 'Token is set via the API_BEARER_TOKEN environment variable.',
    },
    endpoints: [
      {
        method: 'GET',
        path: '/api/health',
        auth: false,
        description: 'Health check. Returns ok if the server is running. Does not test the IMAP connection.',
        params: {},
        returns: '{ status: "ok" }',
      },
      {
        method: 'GET',
        path: '/api/help',
        auth: false,
        description: 'This endpoint. Returns documentation for all available API endpoints.',
        params: {},
        returns: 'This object.',
      },
      {
        method: 'GET',
        path: '/api/mailboxes',
        auth: true,
        description: 'Lists all IMAP mailboxes (folders) on the connected Gmail account.',
        params: {},
        returns: 'Array of mailbox objects.',
      },
      {
        method: 'GET',
        path: '/api/emails',
        auth: true,
        description: 'Lists emails from a mailbox, paginated, newest first.',
        params: {
          mailbox: { type: 'string', default: 'INBOX' },
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20, min: 1, max: 50 },
        },
        returns: '{ messages, total, page, limit }',
      },
      {
        method: 'GET',
        path: '/api/emails/search',
        auth: true,
        description: 'Searches emails using Gmail native search (X-GM-RAW).',
        params: {
          q: { type: 'string', required: true },
          mailbox: { type: 'string', default: '[Gmail]/All Mail' },
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20, min: 1, max: 50 },
        },
        returns: '{ messages, total, page, limit, query }',
      },
      {
        method: 'GET',
        path: '/api/emails/:uid',
        auth: true,
        description: 'Fetches a single email by UID with full body.',
        params: {
          uid: { type: 'number', required: true, in: 'path' },
          mailbox: { type: 'string', default: 'INBOX' },
        },
        returns: '{ uid, flags, date, subject, from, to, cc, textBody, htmlBody, attachments }',
      },
      {
        method: 'POST',
        path: '/api/sync',
        auth: true,
        description: 'Trigger a manual email sync to the memory database.',
        params: {
          mailbox: { type: 'string', default: '[Gmail]/All Mail' },
          sincePreset: { type: 'string', optional: true, description: 'Lookback window preset (e.g. "1d", "1w", "1mo", "all")' },
          limit: { type: 'number', optional: true },
        },
        returns: '{ success, runId, mailbox, fetched, inserted, updated, skipped, attachmentsSeen }',
      },
      {
        method: 'GET',
        path: '/api/sync/status',
        auth: true,
        description: 'Current sync status (idle/running).',
        params: {},
        returns: '{ status, queue }',
      },
      {
        method: 'GET',
        path: '/api/runs',
        auth: true,
        description: 'Sync run history.',
        params: { limit: { type: 'number', default: 50 } },
        returns: 'Array of RunLog objects.',
      },
      {
        method: 'GET',
        path: '/api/jobs',
        auth: true,
        description: 'List scheduled sync jobs.',
        params: {},
        returns: 'Array of Job objects.',
      },
      {
        method: 'POST',
        path: '/api/jobs',
        auth: true,
        description: 'Create a scheduled sync job.',
        params: {
          name: { type: 'string', optional: true },
          mailbox: { type: 'string', default: '[Gmail]/All Mail' },
          cadencePreset: { type: 'string', optional: true },
          sincePreset: { type: 'string', optional: true },
          intervalMinutes: { type: 'number', optional: true },
          limit: { type: 'number', optional: true },
          enabled: { type: 'boolean', default: true },
        },
        returns: 'Job object.',
      },
      {
        method: 'POST',
        path: '/api/jobs/:id/run',
        auth: true,
        description: 'Trigger an immediate run of a scheduled job.',
        params: {},
        returns: '{ success, message }',
      },
      {
        method: 'PATCH',
        path: '/api/jobs/:id',
        auth: true,
        description: 'Update a scheduled job.',
        params: {},
        returns: 'Updated Job object.',
      },
      {
        method: 'DELETE',
        path: '/api/jobs/:id',
        auth: true,
        description: 'Delete a scheduled job.',
        params: {},
        returns: '{ success }',
      },
    ],
  });
});

// Bearer token auth for all /api routes (except health and help)
app.use('/api', (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth === `Bearer ${config.apiToken}`) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized — provide a valid Bearer token' });
});

app.use('/api/mailboxes', mailboxesRouter);
app.use('/api/emails', emailsRouter);
app.use('/api', syncRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);

  // Start the scheduler for recurring jobs
  startScheduler().catch(err => {
    console.error('[Scheduler] Failed to start:', err);
  });
});
