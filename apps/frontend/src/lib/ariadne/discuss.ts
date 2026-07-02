import { ContextIntents, ContextRefKinds, type ContextBag, type ContextRef } from "@threa/types"

/**
 * What a "Discuss with Ariadne" is started from. A `thread` seeds the scratchpad
 * with a windowed slice of one stream; a `conversation` seeds it with the
 * messages of an AI-clustered topic that may span a root stream and its threads
 * (board / conversation-panel surfaces). `sourceMessageId` is the message the
 * user opened the discussion from — the focal for either shape.
 */
export type DiscussTarget =
  | { kind: "thread"; sourceStreamId: string; sourceMessageId?: string }
  | { kind: "conversation"; conversationId: string; rootStreamId: string; sourceMessageId?: string }

/**
 * The single context ref for a discuss target. `originMessageId` carries the
 * focal message (deep-link anchor + `►` marker); for a thread it deliberately
 * does NOT set `fromMessageId` — that would slice the thread server-side and
 * Ariadne would miss the lead-up. A conversation's members are already the
 * intended scope, so it never slices.
 */
function buildDiscussRef(target: DiscussTarget): ContextRef {
  if (target.kind === "conversation") {
    return {
      kind: ContextRefKinds.CONVERSATION,
      conversationId: target.conversationId,
      streamId: target.rootStreamId,
      ...(target.sourceMessageId ? { originMessageId: target.sourceMessageId } : {}),
    }
  }
  return {
    kind: ContextRefKinds.THREAD,
    streamId: target.sourceStreamId,
    ...(target.sourceMessageId ? { originMessageId: target.sourceMessageId } : {}),
  }
}

/**
 * Build the ContextBag payload for "Discuss with Ariadne". Extracted as a helper
 * so every entry point (message context-menu, `/discuss-with-ariadne` slash
 * command, the board/conversation row action) emits the same shape.
 */
export function buildDiscussWithAriadneBag(target: DiscussTarget): ContextBag {
  return {
    intent: ContextIntents.DISCUSS_THREAD,
    refs: [buildDiscussRef(target)],
  }
}
