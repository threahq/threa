/**
 * Render a chip label for a context ref attached to a draft or scratchpad.
 *
 * Examples:
 * - Full thread:    "12 messages in #intro"
 * - Anchored slice: "Slice of #intro"  (sequence-numbered range deferred —
 *                                        needs server-side resolution; tracked
 *                                        as a follow-up)
 * - Empty source:   "Thread in #intro"
 * - No display name yet: "12 messages in this thread"
 *
 * Source data comes from `EnrichedContextRef.source` (server) for the
 * post-send / persistent path, and from the sidebar stream cache for the
 * pre-send draft path. Falls back gracefully when names or counts are
 * unavailable so the strip never renders an empty pill.
 */
export interface ContextRefLabelInput {
  /** Ref kind — a conversation labels as "in this conversation", a thread as a stream handle. */
  kind?: string | null
  /** Display name of the source stream, if known. */
  displayName?: string | null
  /** URL slug of the source stream, if known. Preferred over displayName when both are present. */
  slug?: string | null
  /** Stream type — used to choose between "#name" and "thread in name" framings. */
  streamType?: string | null
  /** Total non-deleted message count in the source stream (or conversation). */
  itemCount?: number | null
  /** Anchor message id at the lower bound of the slice, if any. */
  fromMessageId?: string | null
  /** Anchor message id at the upper bound of the slice, if any. */
  toMessageId?: string | null
}

const ANONYMOUS_FALLBACK = "this thread"

function streamHandle(input: ContextRefLabelInput): string {
  if (input.slug) return `#${input.slug}`
  if (input.displayName) return input.displayName
  return ANONYMOUS_FALLBACK
}

export function formatContextRefLabel(input: ContextRefLabelInput): string {
  // A conversation spans its root + threads, so a single stream handle would
  // undersell it — label by member count and name the shape, not the stream.
  if (input.kind === "conversation") {
    if (typeof input.itemCount === "number" && input.itemCount > 0) {
      const noun = input.itemCount === 1 ? "message" : "messages"
      return `${input.itemCount} ${noun} in this conversation`
    }
    return "This conversation"
  }

  const handle = streamHandle(input)
  // A viewport is what the user had on screen when the aside opened — the
  // server expands it to a window, so a count would describe the expansion,
  // not the capture.
  if (input.kind === "viewport") return `What you saw in ${handle}`

  const isAnchored = Boolean(input.fromMessageId || input.toMessageId)

  // Anchored slices use a "Messages X–Y in #foo" framing. Without resolving
  // the actual sequence numbers, we fall back to "Slice of #foo" so the
  // user still sees something meaningful — sequence resolution is a
  // future enhancement, not a v1 blocker.
  if (isAnchored) {
    return `Slice of ${handle}`
  }

  if (typeof input.itemCount === "number" && input.itemCount > 0) {
    const noun = input.itemCount === 1 ? "message" : "messages"
    return `${input.itemCount} ${noun} in ${handle}`
  }

  return `Thread in ${handle}`
}
