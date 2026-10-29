import { useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import {
  DocErrorCodes,
  STREAM_DISPLAY_NAME_MAX_LENGTH,
  StreamErrorCodes,
  StreamTypes,
  streamTypeCapabilities,
} from "@threahq/types"
import { ApiError } from "@/api/client"
import { useRootWriteAccess } from "@/components/docs/use-doc-can-write"
import { usePanel } from "@/contexts"
import type { ArchivalChainStream } from "@/lib/streams"
import { useCanManageChannels } from "@/lib/use-can-manage-channels"
import { useEffectiveArchived } from "./use-effective-archived"
import { useCreateStream } from "./use-streams"

interface DocHost extends ArchivalChainStream {
  type: string
  e2eEnabled?: boolean | null
}

const CREATE_ERROR_BY_CODE: Record<string, string> = {
  [DocErrorCodes.HOST_TYPE_INVALID]: "Docs can't be created in this stream.",
  [DocErrorCodes.E2E_HOST_NOT_ALLOWED]: "Docs can't be created in an encrypted stream.",
  [StreamErrorCodes.READ_ONLY]: "You can't create docs here.",
}

/** Cuts at the cap without leaving half of a surrogate pair behind. */
const toDocTitle = (title: string) =>
  title
    .trim()
    .slice(0, STREAM_DISPLAY_NAME_MAX_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, "")

/** Creates a doc under `parentStreamId`, or top-level without one; resolves to null when nothing was created. */
function useCreateDocStream(workspaceId: string) {
  const { mutateAsync: createStream, isPending } = useCreateStream(workspaceId)

  const create = useCallback(
    async (parentStreamId: string | undefined, title?: string) => {
      if (isPending) return null
      const displayName = title ? toDocTitle(title) : undefined
      try {
        return await createStream({
          type: StreamTypes.DOC,
          ...(parentStreamId && { parentStreamId }),
          ...(displayName && { displayName }),
        })
      } catch (err) {
        const code = ApiError.isApiError(err) ? err.code : undefined
        toast.error((code && CREATE_ERROR_BY_CODE[code]) ?? "Couldn't create the doc. Please try again.")
        return null
      }
    },
    [createStream, isPending]
  )

  return { create, pending: isPending }
}

/**
 * Create a doc under `host`, titled `title` when given. `create` resolves to the doc, or null when nothing was
 * created; `open` shows a doc in a pane beside the host, and `run` does both. `enabled` is false where the backend
 * would refuse the doc.
 */
export function useCreateDoc(workspaceId: string, host: DocHost | undefined) {
  const { create: createDocStream, pending } = useCreateDocStream(workspaceId)
  const { openPanel } = usePanel()
  const canWriteHost = useRootWriteAccess(workspaceId, host?.id ?? null)
  const { isArchived } = useEffectiveArchived({ workspaceId, stream: host, fallbackArchived: null })
  const enabled = Boolean(
    host && streamTypeCapabilities(host.type).hostsDocs && !host.e2eEnabled && !isArchived && canWriteHost === true
  )
  const hostId = host?.id

  const create = useCallback(
    async (title?: string) => (hostId ? createDocStream(hostId, title) : null),
    [createDocStream, hostId]
  )

  const open = useCallback(
    (docId: string) => {
      if (hostId) openPanel(docId, { beside: hostId })
    },
    [hostId, openPanel]
  )

  const run = useCallback(
    async (title?: string) => {
      const doc = await create(title)
      if (doc) open(doc.id)
      return doc
    },
    [create, open]
  )

  return { enabled, pending, create, open, run }
}

/**
 * Create a top-level doc, private until its settings say otherwise, and go to it. Like a channel, only a viewer
 * who may manage channels creates one.
 */
export function useCreateTopLevelDoc(workspaceId: string) {
  const { create, pending } = useCreateDocStream(workspaceId)
  const enabled = useCanManageChannels(workspaceId)
  const navigate = useNavigate()

  const run = useCallback(async () => {
    const doc = await create(undefined)
    if (doc) navigate(`/w/${workspaceId}/s/${doc.id}`)
    return doc
  }, [create, navigate, workspaceId])

  return { enabled, pending, run }
}
