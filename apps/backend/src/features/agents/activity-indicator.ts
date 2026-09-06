import type { Server } from "socket.io"
import { StreamTypes, type Stream } from "@threahq/types"

/**
 * Where a session running inside a thread has to announce itself besides its own
 * stream. Viewers of the parent timeline never see the trigger message (it lives
 * in the thread), so the frontend keys the inline indicator on the thread's
 * anchor instead — that is what lights the thread slot on the anchor row.
 */
export interface ParentActivityTarget {
  parentStreamId: string
  /** The thread's anchor: `msg_…` for a message, `event_…` for a card. */
  parentMessageId: string
}

/** The parent target for a session running in `stream`, or null when it runs in a root stream. */
export function parentActivityTarget(
  stream: Pick<Stream, "type" | "parentStreamId" | "parentAnchorId"> | null | undefined
): ParentActivityTarget | null {
  if (!stream || stream.type !== StreamTypes.THREAD) return null
  if (!stream.parentStreamId || !stream.parentAnchorId) return null
  return { parentStreamId: stream.parentStreamId, parentMessageId: stream.parentAnchorId }
}

/**
 * Announce a thread session to the parent stream's room, so the anchor's thread
 * slot lights up before the first step lands. `threadStreamId` lets the frontend
 * link straight to the thread without waiting for the slower `stream:created`.
 */
export function emitAgentActivityStarted(
  io: Server,
  params: {
    workspaceId: string
    sessionId: string
    triggerMessageId: string
    personaName: string
    /** The session's own stream — the thread the parent row links to. */
    threadStreamId: string
    target: ParentActivityTarget
  }
): void {
  io.to(`ws:${params.workspaceId}:stream:${params.target.parentStreamId}`).emit("agent_session:activity_started", {
    sessionId: params.sessionId,
    triggerMessageId: params.triggerMessageId,
    personaName: params.personaName,
    threadStreamId: params.threadStreamId,
    parentMessageId: params.target.parentMessageId,
  })
}

/**
 * Clear the parent row's indicator. This event is the ONLY cleanup path there:
 * the session's `agent_session:completed`/`failed` lifecycle events belong to the
 * thread's timeline, which the parent view drops on arrival — so a terminal state
 * that skips this leaves the anchor spinning until a reconnect.
 *
 * A session's root stream is an accepted `parentStreamId` here: a thread sits
 * directly under a non-thread ancestor (INV-62), so its root IS its parent
 * timeline. Null, or the session's own stream, skips the emit.
 */
export function emitAgentActivityEnded(
  io: Server,
  params: {
    workspaceId: string
    streamId: string
    parentStreamId: string | null | undefined
    sessionId: string
    triggerMessageId: string
  }
): void {
  if (!params.parentStreamId || params.parentStreamId === params.streamId) return
  io.to(`ws:${params.workspaceId}:stream:${params.parentStreamId}`).emit("agent_session:activity_ended", {
    sessionId: params.sessionId,
    triggerMessageId: params.triggerMessageId,
  })
}
