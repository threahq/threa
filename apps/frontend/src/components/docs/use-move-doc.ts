import { useCallback, useState } from "react"
import { toast } from "sonner"
import {
  DocErrorCodes,
  StreamErrorCodes,
  WORKSPACE_PERMISSION_SCOPES,
  streamTypeCapabilities,
  type DocMovePreviewResponse,
} from "@threahq/types"
import { ApiError } from "@/api/client"
import { docsApi } from "@/api/docs"
import { useViewerPermissions } from "@/hooks/use-workspaces"
import { useCurrentWorkspaceUserId } from "@/hooks/use-current-workspace-user-id"
import { hasPermission } from "@/lib/permissions"
import type { CachedStream } from "@/stores/workspace-store"

interface MovableDoc {
  id: string
  createdBy?: string | null
  parentStreamId?: string | null
  archivedAt?: string | null
}

export interface PendingDocMove {
  toStreamId: string
  preview: DocMovePreviewResponse
}

const MOVE_ERROR_BY_CODE: Record<string, string> = {
  [DocErrorCodes.MOVED_CONCURRENTLY]: "Someone else moved this doc first.",
  [DocErrorCodes.MOVE_FORBIDDEN]: "Only the doc's creator or a workspace admin can move it.",
  [DocErrorCodes.HOST_TYPE_INVALID]: "Docs can't live in that stream.",
  [DocErrorCodes.E2E_HOST_NOT_ALLOWED]: "Docs can't live in an encrypted stream.",
  [StreamErrorCodes.READ_ONLY]: "You can't move docs there.",
}

const toastMoveError = (err: unknown) => {
  const code = ApiError.isApiError(err) ? err.code : undefined
  toast.error((code && MOVE_ERROR_BY_CODE[code]) ?? "Couldn't move the doc. Please try again.")
}

/**
 * Move a doc to another host. `pick` previews the access change and moves at once when nobody gains or loses
 * read access; otherwise it holds the move in `pending` until `confirm`. The new host shows through the stream
 * caches the move's socket event rewrites, so success says nothing.
 */
export function useMoveDoc(workspaceId: string, doc: MovableDoc | undefined) {
  const currentUserId = useCurrentWorkspaceUserId(workspaceId)
  const isAdmin = hasPermission(useViewerPermissions(workspaceId), WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const [pending, setPending] = useState<PendingDocMove | null>(null)
  const [busy, setBusy] = useState(false)

  const docId = doc?.id
  const fromStreamId = doc?.parentStreamId ?? null
  const enabled = Boolean(
    doc && fromStreamId && !doc.archivedAt && ((currentUserId !== null && doc.createdBy === currentUserId) || isAdmin)
  )

  const isTarget = useCallback(
    (stream: CachedStream) =>
      stream.id !== fromStreamId &&
      streamTypeCapabilities(stream.type).hostsDocs &&
      !stream.e2eEnabled &&
      !stream.originWorkspaceId &&
      !stream.disconnectedAt,
    [fromStreamId]
  )

  const move = useCallback(
    async (toStreamId: string): Promise<boolean> => {
      if (!docId || !fromStreamId) return false
      setBusy(true)
      try {
        await docsApi.move(workspaceId, docId, { fromStreamId, toStreamId })
        return true
      } catch (err) {
        toastMoveError(err)
        return false
      } finally {
        setBusy(false)
      }
    },
    [workspaceId, docId, fromStreamId]
  )

  /** Resolves true once the doc moved, false when it waits on `confirm` or failed. */
  const pick = useCallback(
    async (toStreamId: string): Promise<boolean> => {
      if (!docId) return false
      setBusy(true)
      let preview: DocMovePreviewResponse
      try {
        preview = await docsApi.previewMove(workspaceId, docId, toStreamId)
      } catch (err) {
        setBusy(false)
        toastMoveError(err)
        return false
      }
      if (preview.losing > 0 || preview.gaining > 0) {
        setBusy(false)
        setPending({ toStreamId, preview })
        return false
      }
      return move(toStreamId)
    },
    [workspaceId, docId, move]
  )

  const confirm = useCallback(async (): Promise<boolean> => {
    if (!pending) return false
    const moved = await move(pending.toStreamId)
    setPending(null)
    return moved
  }, [pending, move])

  const cancel = useCallback(() => setPending(null), [])

  return { enabled, isTarget, pick, pending, confirm, cancel, busy }
}

/** "3 people will lose access and 5 will gain it." */
export function describeAccessChange({ losing, gaining }: DocMovePreviewResponse): string {
  const people = (count: number) => (count === 1 ? "1 person" : `${count} people`)
  if (losing > 0 && gaining > 0) return `${people(losing)} will lose access and ${gaining} will gain it.`
  if (losing > 0) return `${people(losing)} will lose access.`
  return `${people(gaining)} will gain access.`
}
