import { useCallback, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  DocErrorCodes,
  StreamErrorCodes,
  WORKSPACE_PERMISSION_SCOPES,
  streamTypeCapabilities,
  type MoveDocInput,
  type Visibility,
  type DocMovePreviewResponse,
} from "@threahq/types"
import { ApiError } from "@/api/client"
import { docsApi } from "@/api/docs"
import { useViewerPermissions } from "@/hooks/use-workspaces"
import { useCurrentWorkspaceUserId } from "@/hooks/use-current-workspace-user-id"
import { hasPermission } from "@/lib/permissions"
import { useCanManageChannels } from "@/lib/use-can-manage-channels"
import type { CachedStream } from "@/stores/workspace-store"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { applyDocMove } from "@/sync/workspace-sync"

interface MovableDoc {
  id: string
  createdBy: string
  parentStreamId?: string | null
  archivedAt?: string | null
}

export interface PendingDocMove {
  input: MoveDocInput
  preview: DocMovePreviewResponse
}

export type DocMoveDestination = { toStreamId: string } | { toStreamId: null; visibility: Visibility }

const MOVE_ERROR_BY_CODE: Record<string, string> = {
  [DocErrorCodes.MOVED_CONCURRENTLY]: "Someone else moved this doc first.",
  [DocErrorCodes.MOVE_CYCLE]: "A doc can't be moved inside itself.",
  [DocErrorCodes.MOVE_FORBIDDEN]: "Only the doc's creator or a workspace admin can move it.",
  [DocErrorCodes.HOST_TYPE_INVALID]: "Docs can't live in that stream.",
  [DocErrorCodes.E2E_HOST_NOT_ALLOWED]: "Docs can't live in an encrypted stream.",
  [StreamErrorCodes.READ_ONLY]: "You can't move docs there.",
}

const toastMoveError = (err: unknown) => {
  const code = ApiError.isApiError(err) ? err.code : undefined
  toast.error((code && MOVE_ERROR_BY_CODE[code]) ?? "Couldn't move the doc. Please try again.")
}

function isKnownDescendant(
  docId: string | undefined,
  targetId: string,
  streamsById: ReadonlyMap<string, CachedStream>
) {
  if (!docId) return false
  const visited = new Set<string>()
  let parentId: string | null | undefined = targetId
  while (parentId) {
    if (parentId === docId) return true
    if (visited.has(parentId)) return false
    visited.add(parentId)
    parentId = streamsById.get(parentId)?.parentStreamId
  }
  return false
}

/**
 * Move a doc to another host. `pick` previews the access change and moves at once when nobody gains or loses
 * read access; otherwise it holds the move in `pending` until `confirm`. `reset` drops a preview still in flight.
 * The move's response re-homes the doc in the caches, so success says nothing. `canMove` carries the pane's
 * write and archive gates.
 */
export function useMoveDoc(workspaceId: string, doc: MovableDoc | undefined, canMove: boolean) {
  const queryClient = useQueryClient()
  const currentUserId = useCurrentWorkspaceUserId(workspaceId)
  const isAdmin = hasPermission(useViewerPermissions(workspaceId), WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const fromStreamId = doc?.parentStreamId ?? null
  const canLift = useCanManageChannels(workspaceId) && fromStreamId !== null
  const [pending, setPending] = useState<PendingDocMove | null>(null)
  const [busy, setBusy] = useState(false)
  const attemptRef = useRef(0)

  const docId = doc?.id
  const streams = useWorkspaceStreams(workspaceId)
  const streamsById = useMemo(() => new Map((streams ?? []).map((stream) => [stream.id, stream])), [streams])
  const enabled = Boolean(
    canMove && doc && !doc.archivedAt && ((currentUserId !== null && doc.createdBy === currentUserId) || isAdmin)
  )

  const isTarget = useCallback(
    (stream: CachedStream) =>
      stream.id !== docId &&
      stream.id !== fromStreamId &&
      !isKnownDescendant(docId, stream.id, streamsById) &&
      streamTypeCapabilities(stream.type).hostsDocs &&
      !stream.e2eEnabled &&
      !stream.originWorkspaceId &&
      !stream.disconnectedAt,
    [docId, fromStreamId, streamsById]
  )

  const move = useCallback(
    async (input: MoveDocInput): Promise<boolean> => {
      if (!docId) return false
      try {
        const { stream } = await docsApi.move(workspaceId, docId, input)
        await applyDocMove(queryClient, workspaceId, { doc: stream, movedStreamIds: [stream.id] })
        return true
      } catch (err) {
        toastMoveError(err)
        return false
      }
    },
    [queryClient, workspaceId, docId]
  )

  /** Resolves true once the doc moved, false when it waits on `confirm`, failed, or was reset meanwhile. */
  const pick = useCallback(
    async (destination: DocMoveDestination): Promise<boolean> => {
      if (!docId) return false
      if (destination.toStreamId === null && !canLift) return false
      const input: MoveDocInput = { fromStreamId, ...destination }
      const attempt = ++attemptRef.current
      const isCurrent = () => attemptRef.current === attempt
      setBusy(true)
      try {
        const preview = await docsApi.previewMove(workspaceId, docId, destination)
        if (!isCurrent()) return false
        if (preview.losing > 0 || preview.gaining > 0) {
          setPending({ input, preview })
          return false
        }
        return await move(input)
      } catch (err) {
        if (isCurrent()) toastMoveError(err)
        return false
      } finally {
        if (isCurrent()) setBusy(false)
      }
    },
    [workspaceId, docId, fromStreamId, canLift, move]
  )

  const confirm = useCallback(async (): Promise<boolean> => {
    if (!pending) return false
    setBusy(true)
    try {
      return await move(pending.input)
    } finally {
      setBusy(false)
      setPending(null)
    }
  }, [pending, move])

  const cancel = useCallback(() => setPending(null), [])

  const reset = useCallback(() => {
    attemptRef.current++
    setPending(null)
    setBusy(false)
  }, [])

  return { enabled, canLift, isTarget, pick, pending, confirm, cancel, reset, busy }
}

export type DocMove = ReturnType<typeof useMoveDoc>

/** "3 people will lose access and 5 will gain it." */
export function describeAccessChange({ losing, gaining }: DocMovePreviewResponse): string {
  const people = (count: number) => (count === 1 ? "1 person" : `${count} people`)
  if (losing > 0 && gaining > 0) return `${people(losing)} will lose access and ${gaining} will gain it.`
  if (losing > 0) return `${people(losing)} will lose access.`
  return `${people(gaining)} will gain access.`
}
