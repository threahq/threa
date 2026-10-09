/** Panel ids share the stream-id slot in the URL, but only some of them name a
 *  stream the server knows: a draft scratchpad (`draft_`), a draft thread panel
 *  (`draft:`), a conversation panel (`conv:`), a conversations list (`convs:`),
 *  a draft pane (`compose:`), an aside (`aside:`), an overview (`context:`), a
 *  persona's test chat (`test:`) and a route's own page (`page:`) are all client-side.
 *  Anything that fetches a stream bootstrap or joins a stream room filters
 *  through this — handing a `conv:` id to either produces a 404 and a rejected
 *  room join. */
export const NON_SERVER_STREAM_ID_PREFIXES = [
  "draft_",
  "draft:",
  "conv:",
  "convs:",
  "compose:",
  "aside:",
  "context:",
  "test:",
  "page:",
] as const

export function isServerStreamId(streamId: string): boolean {
  return !NON_SERVER_STREAM_ID_PREFIXES.some((prefix) => streamId.startsWith(prefix))
}

/** A route's own page, pinned alone in the first column: its route implies it, so `?panel=` never holds it. */
export function isPagePane(panelId: string): boolean {
  return panelId.startsWith("page:")
}
