import { createContext, useContext } from "react"

/**
 * The read pointer's per-stream `sequence` (bigint-as-string), or `null` when
 * the read state isn't resolved or the pointer sits outside the loaded window.
 * Provided by `stream-content`; message rows read it to gate their read-state
 * actions ("Mark read up to here" on unread rows, "Mark as unread" on read
 * rows). `null` means "don't gate" — both actions stay visible — so a surface
 * with no provider (e.g. a context with no resolved read state) is unchanged.
 */
export const ReadFrontierContext = createContext<string | null>(null)

export function useReadFrontier(): string | null {
  return useContext(ReadFrontierContext)
}

export type RowReadState = "read" | "unread" | "ungated"

/**
 * Where a row sits relative to the read pointer. A row is `unread` when its
 * sequence is strictly past the frontier; the row AT the frontier (the last
 * read message) counts as `read`. `ungated` when there's no usable frontier or
 * the row has no sequence yet (optimistic send) — callers show both actions.
 */
export function rowReadState(eventSequence: string | null | undefined, readFrontier: string | null): RowReadState {
  if (readFrontier === null || eventSequence == null) return "ungated"
  return BigInt(eventSequence) > BigInt(readFrontier) ? "unread" : "read"
}
