import type { Stream, StreamEvent, StreamMember, StreamReadFrontier } from "@threa/types"

function generateOptimisticEventId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `temp_${timestamp}${random}`
}

export interface AttachmentSummary {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface CreateOptimisticBootstrapParams {
  stream: Stream
  message: {
    id: string
    createdAt: string
  }
  contentMarkdown: string
  attachments?: AttachmentSummary[]
}

export interface OptimisticBootstrap {
  stream: Stream
  events: StreamEvent[]
  members: StreamMember[]
  membership: StreamMember
  readState: StreamReadFrontier
  latestSequence: string
}

/**
 * Creates an optimistic bootstrap cache for a newly created stream.
 * Used when promoting drafts (scratchpads or threads) to real streams
 * to enable instant navigation without waiting for server fetch.
 */
export function createOptimisticBootstrap({
  stream,
  message,
  contentMarkdown,
  attachments,
}: CreateOptimisticBootstrapParams): OptimisticBootstrap {
  // Use temp_ prefix so WebSocket handler can dedupe by content matching
  // (real events have different IDs like evt_xxx vs the message's msg_xxx)
  const event: StreamEvent = {
    id: generateOptimisticEventId(),
    streamId: stream.id,
    sequence: "1",
    eventType: "message_created",
    payload: {
      messageId: message.id,
      contentMarkdown,
      ...(attachments && attachments.length > 0 && { attachments }),
    },
    actorId: stream.createdBy,
    actorType: "user",
    createdAt: message.createdAt,
  }

  const membership: StreamMember = {
    streamId: stream.id,
    memberId: stream.createdBy,
    notificationLevel: null,
    joinedAt: message.createdAt,
  }

  return {
    stream,
    events: [event],
    members: [membership],
    membership,
    // The creator's own message is born-read: seed the frontier so the optimistic
    // stream doesn't show it as unread.
    readState: { lastReadEventId: event.id, lastReadSequence: "1", lastReadAt: message.createdAt },
    latestSequence: "1",
  }
}
