import type { Response } from "express"
import { bigIntReplacer } from "@threahq/backend-common"
import { bootstrapServeDurationSeconds, bootstrapServeEntitiesReturned, bootstrapServePayloadBytes } from "./metrics"

export type BootstrapKind = "workspace" | "stream"

/** Constant-size catalogues would floor every observation and hide real variation. */
const STATIC_CATALOG_KEYS = new Set(["emojis"])

function countEntities(data: Record<string, unknown>): number {
  let total = 0
  for (const [key, value] of Object.entries(data)) {
    if (STATIC_CATALOG_KEYS.has(key)) continue
    if (Array.isArray(value)) total += value.length
  }
  return total
}

/**
 * Serializes a bootstrap response once, observes size/duration/entity count,
 * and sends the already-built string so nothing is stringified twice.
 */
export function sendBootstrapJson(
  res: Response,
  kind: BootstrapKind,
  startedAt: number,
  data: Record<string, unknown>
): void {
  // Same replacer express's res.json is configured with (app.ts "json replacer").
  const body = JSON.stringify({ data }, bigIntReplacer)
  bootstrapServePayloadBytes.observe({ kind }, Buffer.byteLength(body))
  bootstrapServeEntitiesReturned.observe({ kind }, countEntities(data))
  bootstrapServeDurationSeconds.observe({ kind }, (Date.now() - startedAt) / 1000)
  res.type("application/json").send(body)
}
