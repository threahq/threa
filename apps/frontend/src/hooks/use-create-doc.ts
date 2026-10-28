import { useCallback } from "react"
import { toast } from "sonner"
import { DocErrorCodes, StreamErrorCodes, StreamTypes, streamTypeCapabilities } from "@threahq/types"
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

/** The backend's `displayName` cap for a created stream. */
const DOC_TITLE_MAX_LENGTH = 100

const CREATE_ERROR_BY_CODE: Record<string, string> = {
  [DocErrorCodes.HOST_TYPE_INVALID]: "Docs can't be created in this stream.",
  [DocErrorCodes.E2E_HOST_NOT_ALLOWED]: "Docs can't be created in an encrypted stream.",
  [StreamErrorCodes.READ_ONLY]: "You can't create docs here.",
}

/**
 * Create a doc under `host`, titled `title` when given, and open it in a pane beside it. Resolves to the doc, or
 * null when nothing was created. `enabled` is false where the backend would refuse the doc.
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

  const run = useCallback(
    async (title?: string) => {
      if (!hostId || isPending) return null
      const displayName = title?.trim().slice(0, DOC_TITLE_MAX_LENGTH)
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
      openPanel(doc.id, { beside: hostId })
      return doc
    },
    [createStream, hostId, isPending, openPanel]
  )

  return { enabled, run }
}
