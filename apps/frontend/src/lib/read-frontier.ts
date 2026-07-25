/**
 * Read-frontier source resolution for the read cutover: a standalone
 * `streamReadState` row wins whenever it EXISTS — including a row whose
 * watermark is null (explicit "position before the first message" frontier) —
 * and the `db.streams` / membership mirrors fill only streams with no row yet
 * (cached payloads from before the rollout). Row presence, not field
 * nullability, selects the source, so a present null must never fall through
 * to a stale non-null mirror. Returns `undefined` only while every source is
 * still hydrating (the consumers' `readStateResolved` gate).
 */
export function resolveFrontierEventId(
  readState: { lastReadEventId: string | null } | undefined,
  idbStream: { lastReadEventId?: string | null } | undefined,
  membership: { lastReadEventId: string | null } | null | undefined
): string | null | undefined {
  if (readState) return readState.lastReadEventId
  if (idbStream?.lastReadEventId !== undefined) return idbStream.lastReadEventId
  return membership?.lastReadEventId
}
