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

/**
 * The frontier as a per-stream sequence, for consumers that must compare a read
 * position against events that may not be loaded (the unread divider). `null` is
 * the explicit never-read frontier; `undefined` means unresolvable — an absent
 * row (hydrating) or a watermark id whose sequence is missing (a legacy row).
 * An unresolvable frontier is never guessed as never-read: consumers must wait.
 */
export function resolveFrontierSequence(
  readState: { lastReadEventId: string | null; lastReadSequence: string | null } | undefined
): bigint | null | undefined {
  if (!readState) return undefined
  if (readState.lastReadSequence !== null) return BigInt(readState.lastReadSequence)
  return readState.lastReadEventId === null ? null : undefined
}
