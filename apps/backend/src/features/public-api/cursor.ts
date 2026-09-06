import { HttpError } from "@threahq/backend-common"

interface CursorPayload {
  v: 1
  s: string // sort key (ISO date string)
  id: string // tie-breaker ID
}

export function encodeCursor(sortKey: Date, id: string): string {
  const payload: CursorPayload = { v: 1, s: sortKey.toISOString(), id }
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

export function decodeCursor(cursor: string): { sortKey: Date; id: string } {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf-8")
    const parsed = JSON.parse(raw) as CursorPayload
    if (parsed.v !== 1 || typeof parsed.s !== "string" || typeof parsed.id !== "string") {
      throw new Error("invalid cursor shape")
    }
    const sortKey = new Date(parsed.s)
    if (isNaN(sortKey.getTime())) throw new Error("invalid cursor date")
    return { sortKey, id: parsed.id }
  } catch {
    throw new HttpError("Invalid cursor", { status: 400, code: "INVALID_CURSOR" })
  }
}
