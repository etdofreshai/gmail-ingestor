# openclaw-email-ingestor
Email ingester for OpenClaw memory DB — IMAP sync with contact filtering and management UI


## Reliable local operation

Persist `/app/.data` (or `DATA_DIR`) in a Docker volume. It holds job watermarks
and run history; an ephemeral container filesystem loses both on redeploy.

Scheduled defaults use `DEFAULT_SYNC_LIMIT=0` for a complete incremental window,
processed in batches of 50. A deliberately limited run cannot advance its
watermark when older matching messages were omitted. Unconfirmed API writes,
attachment upload failures and parse failures fail the run and preserve its
previous watermark. Successful watermarks use the run start time so arrivals
during a scan are checked on the next run.

Each scheduled run reports success or failure through the same Memory API at
`/api/sync-state/gmail:HOST:JOB_ID`. Give the ingestor a token scoped to `gmail`.
Use the internal API service address when both containers share a LAN Docker
network. No direct database credential is needed.

Run `npm test` for the write-confirmation and complete-window regression tests.
