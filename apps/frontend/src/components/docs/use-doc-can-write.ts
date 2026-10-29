import { useCallback } from "react"
import { StreamTypes, isOpenVisibility, isTopLevelDoc, type StreamType } from "@threahq/types"
import { useEffectiveArchived, useLandJoinedMembership, useWorkspaceUserId } from "@/hooks"
import { useGuestDmOpen } from "@/lib/use-guest-dm-open"
import {
  useWorkspaceDmPeers,
  useWorkspaceStreamMembership,
  useWorkspaceStream,
  useWorkspaceStreamsSelect,
  type CachedStream,
} from "@/stores/workspace-store"

interface DocCandidate {
  id: string
  type: StreamType
  parentStreamId?: string | null
  rootStreamId?: string | null
  archivedAt?: string | null
}

const pickDocJoinRow = (row: CachedStream) => row

/**
 * Whether the viewer may write under a root stream, archive aside: a member of it, not a shared or
 * disconnected copy, and not a DM the guest DM policy closed. Null while the viewer's identity is still loading.
 */
export function useRootWriteAccess(workspaceId: string, rootStreamId: string | null): boolean | null {
  const viewerUserId = useWorkspaceUserId(workspaceId)
  const selectRootIsCopy = useCallback(
    (streams: CachedStream[]) => {
      const root = streams.find((stream) => stream.id === rootStreamId)
      return Boolean(root?.originWorkspaceId || root?.disconnectedAt)
    },
    [rootStreamId]
  )
  const rootIsCopy = useWorkspaceStreamsSelect(workspaceId, selectRootIsCopy)
  const membership = useWorkspaceStreamMembership(workspaceId, rootStreamId ?? "", viewerUserId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const guestDmOpen = useGuestDmOpen(workspaceId)
  if (!viewerUserId) return null
  if (!rootStreamId || membership === undefined) return false
  if (rootIsCopy) return false
  const dmPeerUserId = dmPeers.find((peer) => peer.streamId === rootStreamId)?.userId
  return dmPeerUserId === undefined || guestDmOpen([dmPeerUserId])
}

/**
 * A hosted doc has no members of its own: it is writable by whoever may write under its root. A top-level doc is
 * its own root, written by its members. Either way only while nothing above it is archived; null while unresolved.
 */
export function useDocCanWrite(workspaceId: string, stream: DocCandidate | null | undefined): boolean | null {
  const doc = stream?.type === StreamTypes.DOC ? stream : null
  const rootAccess = useRootWriteAccess(workspaceId, doc ? (doc.rootStreamId ?? doc.id) : null)
  const { isArchived } = useEffectiveArchived({ workspaceId, stream: doc, fallbackArchived: null })
  if (!doc || isArchived) return false
  return rootAccess
}

export function useDocJoin(workspaceId: string, stream: DocCandidate | null | undefined) {
  const isTopLevel = !!stream && isTopLevelDoc({ type: stream.type, parentStreamId: stream.parentStreamId ?? null })
  const viewerUserId = useWorkspaceUserId(workspaceId)
  const membership = useWorkspaceStreamMembership(workspaceId, isTopLevel ? stream.id : "", viewerUserId)
  const row = useWorkspaceStream(workspaceId, isTopLevel ? stream.id : undefined, pickDocJoinRow)
  const landJoinedMembership = useLandJoinedMembership(workspaceId)

  return {
    canJoin:
      isTopLevel &&
      viewerUserId !== null &&
      membership === undefined &&
      row !== undefined &&
      isOpenVisibility(row.visibility) &&
      !row.archivedAt,
    landJoinedMembership,
  }
}
