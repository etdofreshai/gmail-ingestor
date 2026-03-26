/**
 * email-sync.ts
 *
 * Core sync logic: fetches emails from IMAP and writes them to the
 * memory database via the API writer, including attachment download/ingest.
 */

import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type Attachment as MailAttachment } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';
import { createImapClient } from '../imap';
import {
  writeMessagesViaApi,
  type ApiMessagePayload,
  type ApiWriteResult,
  type EmailAttachment,
} from './api-writer';

export interface SyncOptions {
  /** IMAP mailbox to sync. Default: '[Gmail]/All Mail' */
  mailbox?: string;
  /** Only sync emails after this date (ms since epoch). */
  sinceMs?: number;
  /** Maximum number of emails to sync. */
  limit?: number;
  /** Log progress to console. */
  verbose?: boolean;
  /** Whether to download and ingest attachments. Default: true */
  includeAttachments?: boolean;
  /** Max attachment size in bytes to download. Default: 25MB */
  maxAttachmentSize?: number;
}

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
  attachmentsIngested: number;
  mailbox: string;
}

/**
 * Sync emails from an IMAP mailbox to the memory database.
 *
 * Strategy:
 * 1. Open mailbox via IMAP
 * 2. Search for emails (optionally filtered by date)
 * 3. Fetch each email's full source
 * 4. Parse with mailparser
 * 5. Normalize to memory DB format + extract attachments
 * 6. Write via API (with attachment ingest)
 */
export async function syncEmails(options: SyncOptions = {}): Promise<SyncResult> {
  const mailbox = options.mailbox ?? '[Gmail]/All Mail';
  const sinceMs = options.sinceMs;
  const limit = options.limit;
  const verbose = options.verbose ?? false;
  const includeAttachments = options.includeAttachments !== false;
  const maxAttachmentSize = options.maxAttachmentSize ?? 25 * 1024 * 1024; // 25MB

  const log = verbose ? console.log.bind(console) : () => {};

  log(`[email-sync] Starting sync for mailbox: ${mailbox} (attachments: ${includeAttachments})`);

  const client = await createImapClient();

  try {
    const lock = await client.getMailboxLock(mailbox);

    try {
      // Build search criteria
      const searchCriteria = buildSearchCriteria(sinceMs);

      log(`[email-sync] Searching with criteria:`, JSON.stringify(searchCriteria));

      // Search for matching UIDs
      let uids: number[];
      try {
        const result = await client.search(searchCriteria, { uid: true });
        uids = Array.isArray(result) ? result : [];
      } catch (err) {
        log(`[email-sync] Search failed, falling back to ALL`);
        const result = await client.search({ all: true }, { uid: true });
        uids = Array.isArray(result) ? result : [];
      }

      log(`[email-sync] Found ${uids.length} emails matching criteria`);

      if (uids.length === 0) {
        return { fetched: 0, inserted: 0, updated: 0, skipped: 0, attachmentsSeen: 0, attachmentsIngested: 0, mailbox };
      }

      // Sort UIDs descending (newest first) for limit to take newest
      uids.sort((a, b) => b - a);

      // Apply limit
      if (limit && limit > 0 && uids.length > limit) {
        uids = uids.slice(0, limit);
        log(`[email-sync] Limited to ${limit} newest emails`);
      }

      // Process in batches
      const BATCH_SIZE = 50;
      let totalResult: ApiWriteResult = { inserted: 0, updated: 0, skipped: 0, attachmentsSeen: 0, attachmentsIngested: 0 };
      let fetched = 0;

      for (let i = 0; i < uids.length; i += BATCH_SIZE) {
        const batchUids = uids.slice(i, i + BATCH_SIZE);
        const payloads: Array<{ payload: ApiMessagePayload; attachmentCount: number; attachments?: EmailAttachment[] }> = [];

        // Fetch full source for each email in the batch
        for await (const msg of client.fetch(batchUids, {
          envelope: true,
          flags: true,
          source: true,
          uid: true,
        }, { uid: true })) {
          try {
            const normalized = await normalizeEmail(msg, mailbox, includeAttachments, maxAttachmentSize);
            if (normalized) {
              payloads.push(normalized);
              fetched++;
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`[email-sync] Error normalizing UID ${msg.uid}: ${errMsg}`);
          }
        }

        if (payloads.length > 0) {
          const batchResult = await writeMessagesViaApi(payloads);
          totalResult.inserted += batchResult.inserted;
          totalResult.updated += batchResult.updated;
          totalResult.skipped += batchResult.skipped;
          totalResult.attachmentsSeen += batchResult.attachmentsSeen;
          totalResult.attachmentsIngested += batchResult.attachmentsIngested;

          log(`[email-sync] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ` +
            `fetched=${payloads.length} inserted=${batchResult.inserted} ` +
            `updated=${batchResult.updated} skipped=${batchResult.skipped} ` +
            `attachments=${batchResult.attachmentsSeen} ingested=${batchResult.attachmentsIngested}`);
        }
      }

      log(`[email-sync] Sync complete for ${mailbox}: ` +
        `fetched=${fetched} inserted=${totalResult.inserted} ` +
        `updated=${totalResult.updated} skipped=${totalResult.skipped} ` +
        `attachments=${totalResult.attachmentsSeen} ingested=${totalResult.attachmentsIngested}`);

      return {
        fetched,
        ...totalResult,
        mailbox,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/**
 * Build IMAP search criteria based on the sinceMs parameter.
 */
function buildSearchCriteria(sinceMs?: number): Record<string, unknown> {
  if (sinceMs && sinceMs > 0) {
    const sinceDate = new Date(sinceMs);
    return { since: sinceDate };
  }
  return { all: true };
}

/**
 * Normalize a fetched IMAP message into a memory DB payload,
 * including extracting attachment file data.
 */
async function normalizeEmail(
  msg: FetchMessageObject,
  mailbox: string,
  includeAttachments: boolean,
  maxAttachmentSize: number
): Promise<{ payload: ApiMessagePayload; attachmentCount: number; attachments?: EmailAttachment[] } | null> {
  if (!msg.source) {
    return null;
  }

  const parsed = await simpleParser(msg.source, {});

  const from = msg.envelope?.from;
  const to = msg.envelope?.to;
  const cc = msg.envelope?.cc;
  const subject = msg.envelope?.subject ?? '';
  const date = msg.envelope?.date;
  const messageId = msg.envelope?.messageId;
  const uid = msg.uid;
  const flags = Array.from(msg.flags || []);

  const sender = from?.[0]?.address ?? from?.[0]?.name ?? 'unknown';
  const recipient = to?.map(t => t.address).filter(Boolean).join(', ') || 'unknown';

  const textBody = parsed.text || (parsed.html ? htmlToText(parsed.html, { wordwrap: 120 }) : '');
  const content = `Subject: ${subject}\n\n${textBody}`;
  const htmlBody = parsed.html || undefined;

  const timestamp = date ? new Date(date).toISOString() : new Date().toISOString();
  const externalId = `gmail:${mailbox}:${uid}`;

  const rawAttachments = parsed.attachments ?? [];
  const attachmentCount = rawAttachments.length;

  // Extract attachment data if enabled
  let attachments: EmailAttachment[] | undefined;
  if (includeAttachments && rawAttachments.length > 0) {
    attachments = [];
    for (const att of rawAttachments) {
      try {
        // Skip attachments that are too large
        if (att.size && att.size > maxAttachmentSize) {
          console.log(`[email-sync] Skipping attachment "${att.filename}" (${att.size} bytes) — exceeds max size`);
          continue;
        }

        // att.content is a Buffer from mailparser
        if (att.content && att.content.length > 0) {
          attachments.push({
            filename: att.filename || `attachment-${uid}-${attachments.length}`,
            contentType: att.contentType || 'application/octet-stream',
            content: att.content,
            size: att.size || att.content.length,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[email-sync] Error extracting attachment "${att.filename}" for UID ${uid}: ${errMsg}`);
      }
    }
  }

  // Build attachment metadata for the metadata field
  const attachmentMeta = rawAttachments.map((att) => ({
    filename: att.filename ?? null,
    contentType: att.contentType ?? null,
    size: att.size ?? null,
  }));

  const payload: ApiMessagePayload = {
    source: 'gmail',
    sender,
    recipient,
    content,
    timestamp,
    external_id: externalId,
    metadata: {
      mailbox,
      subject,
      from: from ?? [],
      to: to ?? [],
      cc: cc ?? [],
      uid,
      flags,
      messageId: messageId ?? null,
      attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined,
      htmlBody,
    },
  };

  return { payload, attachmentCount, attachments };
}
