import { HttpError } from "./errors"

/**
 * A keyset position over `(<timestamptz column>, id)`.
 *
 * `at` is the timestamp's full-precision Postgres text, never a `Date`:
 * `timestamptz` keeps microseconds and a JS `Date` only milliseconds, so a
 * boundary that round-trips through a `Date` lands strictly below the real one
 * and every row sharing that millisecond becomes unreachable (INV-66). The
 * predicate casts the text back with `::timestamptz`, which is exact in both
 * directions.
 */
export interface KeysetCursor {
  at: string
  id: string
}

const TIMESTAMP_TEXT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/

/**
 * Shape alone is not enough: `2026-99-99T00:00:00Z` matches the pattern and
 * only fails at the repository's `::timestamptz` cast, turning client input
 * into a 500. `Date.UTC` normalizes out-of-range parts, so comparing the parts
 * back is what rejects them.
 */
function isRealInstant(at: string): boolean {
  const match = TIMESTAMP_TEXT.exec(at)
  if (!match) return false
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const utc = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!))
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month! - 1 &&
    utc.getUTCDate() === day &&
    utc.getUTCHours() === hour &&
    utc.getUTCMinutes() === minute &&
    utc.getUTCSeconds() === second
  )
}

/** Placeholder bound for a cursor-less page: the predicate is off, but its `::timestamptz` cast still runs. */
export const KEYSET_EPOCH = "1970-01-01T00:00:00.000000Z"

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, "utf8").toString("base64url")
}

export function decodeKeysetCursor(raw: string | undefined): KeysetCursor | undefined {
  if (raw === undefined) return undefined
  const decoded = Buffer.from(raw, "base64url").toString("utf8")
  const separator = decoded.indexOf("|")
  const at = decoded.slice(0, separator)
  const id = decoded.slice(separator + 1)
  if (separator === -1 || id.length === 0 || !isRealInstant(at)) {
    throw new HttpError("Invalid cursor", { status: 400, code: "INVALID_CURSOR" })
  }
  return { at, id }
}
