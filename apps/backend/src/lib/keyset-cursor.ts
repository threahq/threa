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

const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

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
  if (separator === -1 || id.length === 0 || !TIMESTAMP_TEXT.test(at)) {
    throw new HttpError("Invalid cursor", { status: 400, code: "INVALID_CURSOR" })
  }
  return { at, id }
}
