import { findArchivedAncestor, type ArchivalChainStream } from "@/lib/streams"
import { useWorkspaceStreamIndex } from "@/stores/workspace-store"

export interface EffectiveArchivedInput {
  workspaceId: string
  /** The anchor stream row; `null`/`undefined` when it is not in any local cache. */
  stream: ArchivalChainStream | null | undefined
  /**
   * Cold-load verdict, used only when the chain cannot be resolved from the
   * local stream cache: the per-stream bootstrap's `archivedAncestor` for the
   * timeline, the board post's `rootArchived` for the conversation surfaces.
   */
  fallbackArchived: { streamId: string; archivedAt: string } | boolean | null | undefined
}

export interface EffectiveArchived {
  /** The anchor stream itself is archived. */
  ownArchived: boolean
  /** A stream above the anchor (thread parent, host, root) is archived. */
  ancestorArchived: boolean
  /** The nearest archived ancestor when known, for surfaces that name it. */
  sealedById: string | null
  isArchived: boolean
}

/**
 * Effective archived state for a stream-anchored surface. Archival is inherited
 * down `parentStreamId` at any depth, so the anchor's own `archivedAt` cannot
 * tell the client it is sealed. The chain is walked over the workspace stream
 * cache (live: `stream:archived`/`stream:unarchived` update those rows), and
 * only when a link is missing does the caller's cold-load verdict apply. A
 * resolved "nothing archived above" beats a stale fallback: merging the two
 * absences was the flicker/rapid-toggle bug.
 */
export function useEffectiveArchived({
  workspaceId,
  stream,
  fallbackArchived,
}: EffectiveArchivedInput): EffectiveArchived {
  const index = useWorkspaceStreamIndex(workspaceId)
  const ancestor = stream ? findArchivedAncestor(stream, (id) => index.get(id)) : null
  let ancestorArchived: boolean
  let sealedById: string | null
  if (ancestor?.resolved) {
    ancestorArchived = ancestor.sealedBy !== null
    sealedById = ancestor.sealedBy?.id ?? null
  } else {
    ancestorArchived = fallbackArchived != null && fallbackArchived !== false
    sealedById = typeof fallbackArchived === "object" && fallbackArchived !== null ? fallbackArchived.streamId : null
  }
  const ownArchived = stream?.archivedAt != null
  return { ownArchived, ancestorArchived, sealedById, isArchived: ownArchived || ancestorArchived }
}
