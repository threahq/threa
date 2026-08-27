// Context-bag primitive: a typed collection of context references attached to a
// stream, resolved on every AI turn. First consumer is "Discuss with Ariadne".
//
// A bag has an `intent` that drives the prompt template and a list of `refs`
// that point at content (threads today; memos/messages/streams later). The
// discriminated union on `kind` is deliberately single-branch for v1 so the
// downstream code already has shape to extend against.

export const ContextIntents = {
  DISCUSS_THREAD: "discuss-thread",
  ASIDE: "aside",
} as const
export type ContextIntent = (typeof ContextIntents)[keyof typeof ContextIntents]
export const CONTEXT_INTENTS = Object.values(ContextIntents) as ContextIntent[]

export const ContextRefKinds = {
  THREAD: "thread",
  CONVERSATION: "conversation",
  VIEWPORT: "viewport",
} as const
export type ContextRefKind = (typeof ContextRefKinds)[keyof typeof ContextRefKinds]
export const CONTEXT_REF_KINDS = Object.values(ContextRefKinds) as ContextRefKind[]

/**
 * A reference to a whole stream (thread/scratchpad/channel). Omitting both
 * `fromMessageId` and `toMessageId` means "whole thread, live-follow".
 */
export type ThreadContextRef = {
  kind: typeof ContextRefKinds.THREAD
  streamId: string
  /**
   * Optional lower slice anchor. When set, the resolver narrows the thread
   * to messages from this id onward. Triggers `formatContextRefLabel`'s
   * "Slice of …" framing. NOT used for navigation — see `originMessageId`.
   */
  fromMessageId?: string
  /** Optional upper slice anchor (inclusive). Same slicing semantics as `fromMessageId`. */
  toMessageId?: string
  /**
   * Originating message id for deep-linking back to the source — purely
   * cosmetic, the resolver ignores it. Lets a chip render "Click to open
   * the source thread" → `?m=<originMessageId>` without the resolver
   * slicing the thread to that one message.
   *
   * Set by "Discuss with Ariadne" so the chip jumps back to the message
   * the user right-clicked on; bag content stays whole-thread for the AI.
   */
  originMessageId?: string
}

/**
 * A reference to a conversation — the AI-clustered topic that spans a root
 * stream and its threads (one root). Unlike a
 * `thread` ref (a whole stream), this resolves to the conversation's specific
 * member messages across streams, so Ariadne sees the topic and nothing else
 * from the surrounding channel.
 *
 * `streamId` is the conversation's root stream as the client believes it — a
 * display hint only (chip identity / optimistic draft root). The server never
 * trusts it: access AND source-stream enrichment both re-derive the
 * authoritative root from the conversation record, so a stale/wrong value here
 * can neither widen access nor leak another stream's metadata (INV-8).
 */
export type ConversationContextRef = {
  kind: typeof ContextRefKinds.CONVERSATION
  conversationId: string
  streamId: string
  /**
   * The message the discussion was opened from. Cosmetic deep-link anchor and
   * the focal message the resolver marks with `►`; it never slices the
   * conversation (its members are already the intended scope).
   */
  originMessageId?: string
}

/**
 * Upper bound on `visibleMessageIds` in a viewport ref. The wire schema rejects
 * longer lists and the client capture caps at the same number, so the two never
 * disagree about what "what you saw" means.
 */
export const VIEWPORT_MAX_VISIBLE_IDS = 60

/**
 * A snapshot of what the user had on screen when an aside was opened: the
 * message ids visible in the host stream's timeline, in viewport order. The
 * resolver expands each id to its surrounding sibling window server-side, so
 * the client never computes a message range — it only reports what it showed.
 */
export type ViewportContextRef = {
  kind: typeof ContextRefKinds.VIEWPORT
  /** The host stream whose timeline was on screen. */
  streamId: string
  /** Message ids intersecting the viewport, top to bottom. */
  visibleMessageIds: string[]
  /** ISO timestamp of the capture. */
  capturedAt: string
}

export type ContextRef = ThreadContextRef | ConversationContextRef | ViewportContextRef

export interface ContextBag {
  intent: ContextIntent
  refs: ContextRef[]
}
