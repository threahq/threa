import { useCallback } from "react"
import { toast } from "sonner"
import { StreamTypes, streamTypeCapabilities } from "@threahq/types"
import { ApiError } from "@/api/client"
import { usePanel } from "@/contexts"
import { useStreamFromStore } from "@/stores/stream-store"
import { useCreateStream } from "./use-streams"

interface DocHost {
  id: string
  type: string
  e2eEnabled?: boolean | null
  archivedAt?: string | null
  rootStreamId?: string | null
}

const CREATE_ERROR_BY_CODE: Record<string, string> = {
  DOC_HOST_TYPE_INVALID: "Docs can't be created in this stream.",
  DOC_E2E_HOST_NOT_ALLOWED: "Docs can't be created in an encrypted stream.",
}

/** Create a doc under `host` and open it in a pane beside it. `enabled` is false where the host cannot hold a doc. */
export function useCreateDoc(workspaceId: string, host: DocHost | undefined) {
  const { mutateAsync: createStream } = useCreateStream(workspaceId)
  const { openPanel } = usePanel()
  const root = useStreamFromStore(workspaceId, host?.rootStreamId ?? undefined)
  const enabled = Boolean(
    host && streamTypeCapabilities(host.type).hostsDocs && !host.e2eEnabled && !host.archivedAt && !root?.archivedAt
  )
  const hostId = host?.id

  const run = useCallback(async () => {
    if (!hostId) return
    let doc
    try {
      doc = await createStream({ type: StreamTypes.DOC, parentStreamId: hostId })
    } catch (err) {
      const code = ApiError.isApiError(err) ? err.code : undefined
      toast.error((code && CREATE_ERROR_BY_CODE[code]) ?? "Couldn't create the doc. Please try again.")
      return
    }
    openPanel(doc.id, { beside: hostId })
  }, [createStream, hostId, openPanel])

  return { enabled, run }
}
