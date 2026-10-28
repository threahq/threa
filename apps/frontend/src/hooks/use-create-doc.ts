import { useCallback } from "react"
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

/**
 * Create a doc under `host`, titled `title` when given. `create` resolves to the doc, or null when nothing was
 * created; `open` shows a doc in a pane beside the host, and `run` does both. `enabled` is false where the backend
 * would refuse the doc.
 */
export function useCreateDoc(workspaceId: string, host: DocHost | undefined) {
  const { mutateAsync: createStream, isPending } = useCreateStream(workspaceId)
  const { openPanel } = usePanel()
  const canWriteHost = useRootWriteAccess(workspaceId, host?.id ?? null)
  const { isArchived } = useEffectiveArchived({ workspaceId, stream: host, fallbackArchived: null })
  const enabled = Boolean(
    host && streamTypeCapabilities(host.type).hostsDocs && !host.e2eEnabled && !isArchived && canWriteHost === true
  )
  const hostId = host?.id

  const create = useCallback(
    async (title?: string) => {
      if (!hostId || isPending) return null
      const displayName = title ? toDocTitle(title) : undefined
      let doc
      try {
        doc = await createStream({
          type: StreamTypes.DOC,
          parentStreamId: hostId,
          ...(displayName && { displayName }),
        })
      } catch (err) {
        const code = ApiError.isApiError(err) ? err.code : undefined
        toast.error((code && CREATE_ERROR_BY_CODE[code]) ?? "Couldn't create the doc. Please try again.")
        return null
      }
      return doc
    },
    [createStream, hostId, isPending]
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

  return { enabled, pending: isPending, create, open, run }
}
