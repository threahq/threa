import { HttpError } from "../../lib/errors"
import type { StreamContextCursor } from "./read-repository"

/**
 * Opaque keyset cursor. The only encoder/decoder — a malformed cursor is a 400
 * (INV-32), never a silent reset to the unfiltered first page.
 */
export function encodeContextCursor(cursor: StreamContextCursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url")
}

export function decodeContextCursor(raw: string | undefined): StreamContextCursor | undefined {
  if (raw === undefined) return undefined
  const decoded = Buffer.from(raw, "base64url").toString("utf8")
  const separator = decoded.indexOf("|")
  const occurredAt = new Date(decoded.slice(0, separator))
  const id = decoded.slice(separator + 1)
  if (separator === -1 || id.length === 0 || Number.isNaN(occurredAt.getTime())) {
    throw new HttpError("Invalid cursor", { status: 400, code: "INVALID_CURSOR" })
  }
  return { occurredAt, id }
}
