/**
 * Memory Database API write module for email messages.
 *
 * Supports both plain JSON writes and multipart ingest with file attachments.
 * Mirrors openclaw-chatgpt-ingestor api-writer.ts patterns.
 */

/** Conflict mode for the Memory Database API. */
export type ConflictMode = 'skip_or_append' | 'skip_or_overwrite';

/** Resolve conflict_mode from env var, falling back to provided default or 'skip_or_append'. */
export function getConflictMode(override?: string): ConflictMode {
  const raw = override || process.env.CONFLICT_MODE || 'skip_or_append';
  return raw === 'skip_or_overwrite' ? 'skip_or_overwrite' : 'skip_or_append';
}

const MAX_API_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;

export function isApiMode(): boolean {
  return !!(
    process.env.MEMORY_DATABASE_API_URL?.trim() &&
    process.env.MEMORY_DATABASE_API_TOKEN?.trim()
  );
}

export type ApiMessagePayload = {
  source: 'gmail';
  sender: string;
  recipient: string;
  content: string;
  timestamp: string;
  external_id: string;
  metadata: Record<string, unknown>;
};

/** An email attachment with file data. */
export type EmailAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
};

type SingleWriteOutcome = 'inserted' | 'updated' | 'skipped';

export type ApiWriteResult = {
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
  attachmentsIngested: number;
};

async function writeOneMessage(
  baseUrl: string,
  token: string,
  payload: ApiMessagePayload,
  conflictMode?: ConflictMode
): Promise<SingleWriteOutcome> {
  const mode = conflictMode || getConflictMode();
  const qs = mode !== 'skip_or_append' ? `?conflict_mode=${mode}` : '';
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    let res: Response;

    try {
      res = await fetch(`${baseUrl}/api/messages${qs}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(`[api-writer] Network error for external_id=${payload.external_id} — exhausted retries:`, err);
        return 'skipped';
      }
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 429) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(`[api-writer] 429 for external_id=${payload.external_id} — exhausted retries`);
        return 'skipped';
      }
      const retryHeader = res.headers.get('retry-after') ?? '5';
      const waitMs = Math.ceil((parseFloat(retryHeader) || 5) * 1_000) + 500;
      console.warn(`[api-writer] 429 — waiting ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(`[api-writer] API error ${res.status} for external_id=${payload.external_id} — exhausted retries`);
        return 'skipped';
      }
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 201) return 'inserted';
    if (res.status === 200) return 'updated';
    if (res.status === 409) return 'updated';

    const body = await res.text().catch(() => '');
    console.error(`[api-writer] Unrecoverable API error ${res.status} for external_id=${payload.external_id}: ${body.slice(0, 200)}`);
    return 'skipped';
  }

  return 'skipped';
}

/**
 * Ingest a single file attachment via POST /api/messages/ingest (multipart).
 */
async function ingestOneFile(
  baseUrl: string,
  token: string,
  payload: ApiMessagePayload,
  attachment: EmailAttachment,
  conflictMode?: ConflictMode
): Promise<boolean> {
  const mode = conflictMode || getConflictMode();
  const qs = `?conflict_mode=${mode}`;
  const filename = attachment.filename || 'attachment';
  const contentType = attachment.contentType || 'application/octet-stream';
  const attachmentsMeta = [
    {
      original_file_name: filename,
      created_at_source: payload.timestamp,
    },
  ];

  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      const form = new FormData();
      form.append('message', JSON.stringify(payload));
      form.append(
        'files',
        new Blob([new Uint8Array(attachment.content)], { type: contentType }),
        filename
      );
      form.append('attachments_meta', JSON.stringify(attachmentsMeta));

      const res = await fetch(`${baseUrl}/api/messages/ingest${qs}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'openclaw-gmail-ingestor/1.0',
        },
        body: form,
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.warn(`[api-writer] 429 rate limit on ingest for ${filename}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`API returned ${res.status}: ${body.slice(0, 500)}`);
      }

      console.log(`[api-writer] ✓ Ingested attachment ${filename} for ${payload.external_id}`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= MAX_API_RETRIES) {
        console.error(`[api-writer] Failed to ingest ${filename} for ${payload.external_id}: ${msg}`);
        return false;
      }
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(`[api-writer] Error ingesting ${filename} (attempt ${attempt + 1}), retrying in ${backoff}ms: ${msg}`);
      await sleep(backoff);
    }
  }

  return false;
}

export async function writeMessagesViaApi(
  payloads: Array<{ payload: ApiMessagePayload; attachmentCount: number; attachments?: EmailAttachment[] }>,
  conflictMode?: ConflictMode
): Promise<ApiWriteResult> {
  const baseUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;
  const mode = conflictMode || getConflictMode();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let attachmentsSeen = 0;
  let attachmentsIngested = 0;

  for (const { payload, attachmentCount, attachments } of payloads) {
    attachmentsSeen += attachmentCount;

    if (attachments && attachments.length > 0) {
      // Ingest each attachment via multipart endpoint
      let ingestedAny = false;
      for (const att of attachments) {
        const ok = await ingestOneFile(baseUrl, writeToken, payload, att, mode);
        if (ok) {
          attachmentsIngested++;
          ingestedAny = true;
        }

        // Small delay between attachment uploads to avoid throttling
        await sleep(100);
      }

      let outcome: SingleWriteOutcome;
      if (ingestedAny) {
        // The ingest endpoint also writes/links the message
        outcome = 'updated';
      } else {
        // All file ingests failed — fall back to plain JSON write
        console.warn(`[api-writer] All attachment ingests failed for ${payload.external_id} — falling back to plain JSON write`);
        outcome = await writeOneMessage(baseUrl, writeToken, payload, mode);
      }

      if (outcome === 'inserted') inserted++;
      else if (outcome === 'updated') updated++;
      else skipped++;
    } else {
      // No attachments — plain JSON write
      const outcome = await writeOneMessage(baseUrl, writeToken, payload, mode);
      if (outcome === 'inserted') inserted++;
      else if (outcome === 'updated') updated++;
      else skipped++;
    }
  }

  return { inserted, updated, skipped, attachmentsSeen, attachmentsIngested };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
