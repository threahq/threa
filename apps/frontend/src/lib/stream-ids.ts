/** Panel ids share the stream-id slot in the URL, but only some of them name a
 *  stream the server knows: a draft scratchpad (`draft_`), a draft thread panel
 *  (`draft:`) and a conversation panel (`conv:`) are all client-side. Anything
 *  that fetches a stream bootstrap or joins a stream room filters through this —
 *  handing a `conv:` id to either produces a 404 and a rejected room join. */
const NON_SERVER_STREAM_ID_PREFIXES = ["draft_", "draft:", "conv:"] as const

export function isServerStreamId(streamId: string): boolean {
  return !NON_SERVER_STREAM_ID_PREFIXES.some((prefix) => streamId.startsWith(prefix))
}
