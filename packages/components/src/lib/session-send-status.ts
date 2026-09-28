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
      const attachments = record.stage === 'saved' ? (record.attachments ?? []) : [];
      for (const attachment of attachments) {
        totalBytes += attachmentBytes(attachment);
        sentBytes += attachmentSentBytes(attachment);
      }
      stageSum += stageProgress(record);
    }
    // Bytes describe the upload the user is waiting on; with none to measure the
    // ring falls back to how far the messages have moved through their stages.
    const progress =
      totalBytes > 0
        ? Math.min(99, Math.round((sentBytes / totalBytes) * 100))
        : Math.round(stageSum / list.length);
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
