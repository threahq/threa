import { streamLabel } from "@/lib/streams"
import { useWorkspaceStream, type CachedStream } from "@/stores/workspace-store"

/** The fields `streamLabel` reads, for a store subscription that re-renders only when the label can change. */
export const pickStreamLabel = (row: CachedStream) => ({
  id: row.id,
  type: row.type,
  slug: row.slug,
  displayName: row.displayName,
  e2eEnabled: row.e2eEnabled,
  sealedNameCiphertext: row.sealedNameCiphertext,
})

/**
 * The doc's current title from the workspace store: `title` only when the doc has a real name,
 * `label` falling back to the cached title, then the store's "Untitled", then "Doc".
 */
export function useLiveDocTitle(
  workspaceId: string | undefined,
  docId: string | undefined,
  cachedTitle: string
): { title: string | null; label: string } {
  const stream = useWorkspaceStream(workspaceId, docId, pickStreamLabel)
  const title = stream?.displayName ? streamLabel(stream) : null
  return { title, label: title ?? (cachedTitle || (stream ? streamLabel(stream) : "Doc")) }
}
