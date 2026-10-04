/**
 * Resolves flexible stream identifiers to entity IDs so agents can reference streams
 * without knowing the exact format: "stream_xxx" (ID), "general" (slug), "#general" (prefixed slug)
 */

import type { Querier } from "../../../db"
import { StreamRepository } from "../../streams"
import { logger } from "../../../lib/logger"

export type ResolveResult = { resolved: true; id: string } | { resolved: false; reason: string }

function isStreamId(value: string): boolean {
  return value.startsWith("stream_")
}

function normalizeStreamRef(value: string): string {
  return value.replace(/^#/, "").trim()
}

/**
 * Resolve a stream identifier (ID, slug, or #slug) to its ID. When
 * `accessibleStreamIds` is provided, resolution fails for streams outside it.
 */
export async function resolveStreamIdentifier(
  db: Querier,
  workspaceId: string,
  identifier: string,
  accessibleStreamIds?: string[]
): Promise<ResolveResult> {
  const trimmed = identifier.trim()

  if (!trimmed) {
    return { resolved: false, reason: "Empty identifier" }
  }

  if (isStreamId(trimmed)) {
    if (accessibleStreamIds && !accessibleStreamIds.includes(trimmed)) {
      return { resolved: false, reason: `Stream not accessible: ${trimmed}` }
    }
    return { resolved: true, id: trimmed }
  }

  const slug = normalizeStreamRef(trimmed)

  const stream = await StreamRepository.findBySlug(db, workspaceId, slug)

  if (!stream) {
    return { resolved: false, reason: `No stream found with slug: ${slug}` }
  }

  if (accessibleStreamIds && !accessibleStreamIds.includes(stream.id)) {
    return { resolved: false, reason: `Stream not accessible: ${slug}` }
  }

  logger.debug({ identifier, resolvedId: stream.id, slug }, "Resolved stream identifier")

  return { resolved: true, id: stream.id }
}
