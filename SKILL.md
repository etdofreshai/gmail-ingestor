---
name: openclaw-gmail-ingestor
description: Sync IMAP email (filtered senders) into OpenClaw Postgres with API endpoints.
---

# openclaw-gmail-ingestor

## Purpose
Ingest approved emails from IMAP/Gmail into OpenClaw `messages`.

## Setup
```bash
npm install
cp .env.example .env
```

Required env (minimum):
- `DATABASE_URL`
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD`

## Run
```bash
npm run dev      # dev server
npm run build
npm run start    # compiled server
```

## API
- `GET /api/status`
- `GET /api/emails`
- filter/sync endpoints (see README)

## Notes
- Uses filtering rules to avoid newsletter/noise ingestion
- Writes to existing `messages` table
