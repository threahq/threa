import type { Response } from "express"

/** Bytes authored by users or fetched from third parties, served from the app origin, must never execute as a document. */
export function setUntrustedContentHeaders(res: Response): void {
  res.set("X-Content-Type-Options", "nosniff")
  res.set("Content-Security-Policy", "sandbox")
}
