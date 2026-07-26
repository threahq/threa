/**
 * Read-frontier resolution: `stream_read_state` is the sole source. A present
 * row is resolved — including a row whose watermark is null (explicit "position
 * before the first message" frontier). Returns `undefined` only while the row is
 * still hydrating (absent), so consumers gate on `readStateResolved` until the
 * authoritative bootstrap / stream bootstrap seeds never-read.
 */
export function resolveFrontierEventId(
  readState: { lastReadEventId: string | null } | undefined
): string | null | undefined {
  return readState?.lastReadEventId
}
