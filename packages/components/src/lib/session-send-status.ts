import type { SessionSendViewRecord } from './session-send-journal';

export type SessionSendState = 'sending' | 'failed';

/** Renderer-local projection of the send journal for one session; never synced. */
export type SessionSendStatus = {
  state: SessionSendState;
  /** 0–100 across every unfinished message of the session. */
  progress: number;
  sentBytes: number;
  totalBytes: number;
  /** A new conversation whose first message has not been written to history yet. */
  unsentNewConversation: boolean;
};

type Attachment = NonNullable<SessionSendViewRecord['attachments']>[number];

function attachmentBytes(attachment: Attachment): number {
  if (attachment.source) return attachment.source.size;
  const ready = attachment.ready as { sizeBytes?: unknown } | undefined;
  return typeof ready?.sizeBytes === 'number' ? ready.sizeBytes : 0;
}

function attachmentSentBytes(attachment: Attachment): number {
  const total = attachmentBytes(attachment);
  if (attachment.ready) return total;
  const progress = Math.min(100, Math.max(0, attachment.progress ?? 0));
  return (total * progress) / 100;
}

/** Stage weight when a message carries no measurable bytes. */
function stageProgress(record: SessionSendViewRecord): number {
  return record.stage === 'prepared' ? 90 : 5;
}

function recordBytes(record: SessionSendViewRecord) {
  let totalBytes = 0;
  let sentBytes = 0;
  const attachments = record.stage === 'saved' ? (record.attachments ?? []) : [];
  for (const attachment of attachments) {
    totalBytes += attachmentBytes(attachment);
    sentBytes += attachmentSentBytes(attachment);
  }
  return { totalBytes, sentBytes };
}

function progressOf(sentBytes: number, totalBytes: number, fallback: number) {
  return totalBytes > 0 ? Math.min(99, Math.round((sentBytes / totalBytes) * 100)) : fallback;
}

export type SessionSendRecordProgress = {
  state: SessionSendState;
  /** 0–100; bytes when measurable, otherwise the message's stage. */
  progress: number;
  sentBytes: number;
  totalBytes: number;
};

/** One unsent message's own status, for surfaces that list messages separately. */
export function deriveSessionSendRecordProgress(
  record: SessionSendViewRecord
): SessionSendRecordProgress {
  const { totalBytes, sentBytes } = recordBytes(record);
  return {
    state: record.error || record.activity === 'interrupted' ? 'failed' : 'sending',
    progress: progressOf(sentBytes, totalBytes, stageProgress(record)),
    sentBytes: Math.round(sentBytes),
    totalBytes,
  };
}

/**
 * A queue-bound message was routed to the queue because the Agent was busy. Until
 * its attachments are ready it must not exist as an executable queue row, so it
 * lives only in the local journal, but it is SHOWN in the queue sheet rather
 * than in the conversation stream: it would otherwise sit in the stream and then
 * jump into the queue when its upload finished.
 */
export function isQueueBoundSendRecord(record: SessionSendViewRecord): boolean {
  return Boolean(record.queue);
}

/**
 * The local rows the queue sheet draws below the real queue, in send order. A
 * record whose queue item is already in the synced queue is hidden, even before
 * the journal marks it committed, so the two never render together.
 */
export function selectPendingQueueRecords(
  records: readonly SessionSendViewRecord[],
  sessionId: string,
  queuedTurnIds: ReadonlySet<string>
): SessionSendViewRecord[] {
  return records.filter(
    (record) =>
      record.sessionId === sessionId &&
      isQueueBoundSendRecord(record) &&
      (record.stage === 'saved' || record.stage === 'prepared') &&
      !record.cancelRequested &&
      !queuedTurnIds.has(record.id)
  );
}

/**
 * Only messages not yet in history count, the same set the conversation's
 * pending rows show: a committed message already reads as an ordinary turn.
 */
export function deriveSessionSendStatuses(
  records: readonly SessionSendViewRecord[]
): Record<string, SessionSendStatus> {
  const bySession = new Map<string, SessionSendViewRecord[]>();
  for (const record of records) {
    if (record.stage !== 'saved' && record.stage !== 'prepared') continue;
    if (record.cancelRequested) continue;
    const list = bySession.get(record.sessionId);
    if (list) list.push(record);
    else bySession.set(record.sessionId, [record]);
  }
  const statuses: Record<string, SessionSendStatus> = {};
  for (const [sessionId, list] of bySession) {
    let totalBytes = 0;
    let sentBytes = 0;
    let stageSum = 0;
    let failed = false;
    let unsentNewConversation = false;
    for (const record of list) {
      if (record.error || record.activity === 'interrupted') failed = true;
      if (record.creation) unsentNewConversation = true;
      const bytes = recordBytes(record);
      totalBytes += bytes.totalBytes;
      sentBytes += bytes.sentBytes;
      stageSum += stageProgress(record);
    }
    // Bytes describe the upload the user is waiting on; with none to measure the
    // ring falls back to how far the messages have moved through their stages.
    const progress = progressOf(sentBytes, totalBytes, Math.round(stageSum / list.length));
    statuses[sessionId] = {
      state: failed ? 'failed' : 'sending',
      progress,
      sentBytes: Math.round(sentBytes),
      totalBytes,
      unsentNewConversation,
    };
  }
  return statuses;
}
