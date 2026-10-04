import { createSelectorContext } from "@/lib/selector-context"

const EMPTY_OVERLAY: ReadonlySet<string> = new Set()

/**
 * Per-stream read frontier for the open timeline: the read pointer's `sequence`
 * (bigint-as-string, or `null` when the read state isn't resolved or the pointer
 * sits outside the loaded window) plus the sparse read overlay — message ids read
 * individually *above* the watermark. A row
 * is *effectively* read when its id is in the overlay even if its sequence sits
 * past the frontier. Provided by `stream-content`; message rows read it to gate
 * their read-state actions. The default (`{ sequence: null, overlay: ∅ }`) means
 * "don't gate" — both actions stay visible — so a surface with no provider is
 * unchanged.
 */
export interface ReadFrontier {
  sequence: string | null
  overlay: ReadonlySet<string>
}

export const ReadFrontierContext = createSelectorContext<ReadFrontier>({ sequence: null, overlay: EMPTY_OVERLAY })

export type RowReadState = "read" | "unread" | "ungated"

/**
 * Where a row sits relative to the *effective* read state. A row is `read` when
 * its id is in the overlay (individually read above the watermark) or its
 * sequence is at/before the frontier; `unread` only when its sequence is
 * strictly past the frontier AND it isn't in the overlay; `ungated` when there's
 * no usable frontier or the row has no sequence yet (optimistic send) and isn't
 * overlay-read — callers show both actions.
 */
export function rowReadState(
  eventSequence: string | null | undefined,
  messageId: string | null | undefined,
  frontier: ReadFrontier
): RowReadState {
  if (messageId != null && frontier.overlay.has(messageId)) return "read"
  if (frontier.sequence === null || eventSequence == null) return "ungated"
  return BigInt(eventSequence) > BigInt(frontier.sequence) ? "unread" : "read"
}

export function useRowReadState(
  eventSequence: string | null | undefined,
  messageId: string | null | undefined
): RowReadState {
  return ReadFrontierContext.useSelector((frontier) => rowReadState(eventSequence, messageId, frontier))
}
