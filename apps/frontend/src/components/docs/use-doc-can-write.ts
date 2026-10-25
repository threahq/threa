import { StreamTypes, type StreamType } from "@threahq/types"
import { useEffectiveArchived, useWorkspaceUserId } from "@/hooks"
import { useWorkspaceStreamMembership } from "@/stores/workspace-store"

interface DocCandidate {
  id: string
  type: StreamType
  parentStreamId?: string | null
  rootStreamId?: string | null
  archivedAt?: string | null
}

/** A doc has no members of its own: whoever is a member of its root may edit it while nothing above it is archived. */
export function useDocCanWrite(workspaceId: string, stream: DocCandidate | null | undefined): boolean {
  const doc = stream?.type === StreamTypes.DOC ? stream : null
  const viewerUserId = useWorkspaceUserId(workspaceId)
  const rootMembership = useWorkspaceStreamMembership(workspaceId, doc?.rootStreamId ?? "", doc ? viewerUserId : null)
  const { isArchived } = useEffectiveArchived({ workspaceId, stream: doc, fallbackArchived: null })
  return doc !== null && rootMembership !== undefined && !isArchived
}
