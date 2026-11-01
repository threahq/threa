import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import { StreamTypes, isTopLevelDoc } from "@threahq/types"

const PARAM_STREAM_MEMBERS = "stream-members"

/**
 * Streams whose member list is a managed surface: a thread shows its root's
 * people, a hosted doc takes its host's, and system/aside streams have none.
 */
export function streamHasMembers(stream: { type: string; parentStreamId: string | null } | null | undefined) {
  if (!stream) return false
  switch (stream.type) {
    case StreamTypes.CHANNEL:
    case StreamTypes.SCRATCHPAD:
    case StreamTypes.DM:
    case StreamTypes.THREAD:
      return true
    case StreamTypes.DOC:
      return isTopLevelDoc(stream)
    default:
      return false
  }
}

export function useStreamMembers() {
  const [searchParams, setSearchParams] = useSearchParams()
  const streamId = searchParams.get(PARAM_STREAM_MEMBERS)

  const openStreamMembers = useCallback(
    (sid: string) => {
      const next = new URLSearchParams(searchParams)
      next.set(PARAM_STREAM_MEMBERS, sid)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  const closeStreamMembers = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete(PARAM_STREAM_MEMBERS)
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  return { isOpen: streamId !== null, streamId, openStreamMembers, closeStreamMembers }
}
