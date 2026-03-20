/**
 * email-sync.ts
 *
 * Core sync logic: fetches emails from IMAP and writes them to the
 * memory database via the API writer.
 */

import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createImapClient } from '../imap';
import {
  writeMessagesViaApi,
  type ApiMessagePayload,
  type ApiWriteResult,
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
}

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
  mailbox: string;
}

interface EmailEnvelope {
  uid: number;
  flags: Set<string>;
  envelope: {
    date?: Date;
    subject?: string;
    from?: Array<{ name?: string; address?: string }>;
    to?: Array<{ name?: string; address?: string }>;
    cc?: Array<{ name?: string; address?: string }>;
    messageId?: string;
  };
}

/**
 * Sync emails from an IMAP mailbox to the memory database.
 *
 * Strategy:
 * 1. Open mailbox via IMAP
 * 2. Search for emails (optionally filtered by date)
 * 3. Fetch each email's full source
 * 4. Parse with mailparser
 * 5. Normalize to memory DB format
 * 6. Write via API
 */
export async function syncEmails(options: SyncOptions = {}): Promise<SyncResult> {
  const mailbox = options.mailbox ?? '[Gmail]/All Mail';
  const sinceMs = options.sinceMs;
  const limit = options.limit;
  const verbose = options.verbose ?? false;

  const log = verbose ? console.log.bind(console) : () => {};

  log(`[email-sync] Starting sync for mailbox: ${mailbox}`);

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
        return { fetched: 0, inserted: 0, updated: 0, skipped: 0, attachmentsSeen: 0, mailbox };
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
      let totalResult: ApiWriteResult = { inserted: 0, updated: 0, skipped: 0, attachmentsSeen: 0 };
      let fetched = 0;

      for (let i = 0; i < uids.length; i += BATCH_SIZE) {
        const batchUids = uids.slice(i, i + BATCH_SIZE);
        const payloads: Array<{ payload: ApiMessagePayload; attachmentCount: number }> = [];

        // Fetch full source for each email in the batch
        for await (const msg of client.fetch(batchUids, {
          envelope: true,
          flags: true,
          source: true,
          uid: true,
        }, { uid: true })) {
          try {
            const normalized = await normalizeEmail(msg, mailbox);
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

          log(`[email-sync] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ` +
            `fetched=${payloads.length} inserted=${batchResult.inserted} ` +
            `updated=${batchResult.updated} skipped=${batchResult.skipped}`);
        }
      }

      log(`[email-sync] Sync complete for ${mailbox}: ` +
        `fetched=${fetched} inserted=${totalResult.inserted} ` +
        `updated=${totalResult.updated} skipped=${totalResult.skipped} ` +
        `attachments=${totalResult.attachmentsSeen}`);

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
 * Normalize a fetched IMAP message into a memory DB payload.
 */
async function normalizeEmail(
  msg: FetchMessageObject,
  mailbox: string
): Promise<{ payload: ApiMessagePayload; attachmentCount: number } | null> {
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

  const textBody = parsed.text ?? '';
  const content = `Subject: ${subject}\n\n${textBody}`;

  const timestamp = date ? new Date(date).toISOString() : new Date().toISOString();
  const externalId = `gmail:${mailbox}:${uid}`;

  const attachmentCount = parsed.attachments?.length ?? 0;

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
    },
  };

  return { payload, attachmentCount };
}
