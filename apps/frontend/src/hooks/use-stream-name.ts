import { resolveStreamName, type FallbackContext } from "@/lib/streams"
import { useWorkspaceStreams, useWorkspaceUsers, useWorkspaceDmPeers } from "@/stores/workspace-store"

/**
 * Resolve a stream's display name from the workspace caches by id. Handles
 * every stream type (DM peer names, channel slugs, generated/placeholder names)
 * so callers never reimplement the cache lookup + DM resolution dance.
 *
 * Returns null when the id resolves to neither a DM peer nor a cached stream;
 * callers layer their own last-resort fallback (a persisted snapshot name, a
 * generic placeholder, etc.).
 */
export function useStreamName(workspaceId: string, streamId: string, context?: FallbackContext): string | null {
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  return resolveStreamName(streamId, { streams, users, dmPeers }, context)
}
