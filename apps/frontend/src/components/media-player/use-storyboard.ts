import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { VideoStoryboardStatuses, type VideoStoryboard } from "@threahq/types"
import { attachmentsApi, attachmentStoryboardSpriteUrl } from "@/api"
import { isPendingGalleryId } from "@/components/gallery/pending-gallery-id"
import type { LoadedStoryboard } from "./storyboard"

const POLL_MS = 3_000
/** Two minutes of polling. A storyboard takes seconds; past this its job is stuck and the decoder preview stays. */
const MAX_UPDATES = 40

const isPending = (data: VideoStoryboard | undefined) => data?.status === VideoStoryboardStatuses.PENDING

/** The video's storyboard once its sprite image has loaded; null until then, and whenever there is none. */
export function useStoryboard(workspaceId: string, attachmentId: string | null): LoadedStoryboard | null {
  const enabled = attachmentId !== null && !isPendingGalleryId(attachmentId)
  const { data } = useQuery({
    queryKey: ["attachment-storyboard", workspaceId, attachmentId],
    queryFn: () => attachmentsApi.ensureStoryboard(workspaceId, attachmentId!),
    enabled,
    retry: false,
    staleTime: (query) => (isPending(query.state.data) ? 0 : Infinity),
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      isPending(query.state.data) && query.state.dataUpdateCount < MAX_UPDATES ? POLL_MS : false,
  })

  const ready = enabled && data?.status === VideoStoryboardStatuses.READY ? data : null
  const spriteUrl = ready ? attachmentStoryboardSpriteUrl(workspaceId, attachmentId!) : null
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!spriteUrl) return
    const image = new Image()
    const onLoad = () => setLoadedUrl(spriteUrl)
    image.addEventListener("load", onLoad)
    image.src = spriteUrl
    return () => image.removeEventListener("load", onLoad)
  }, [spriteUrl])

  return useMemo(
    () => (ready && spriteUrl && loadedUrl === spriteUrl ? { ...ready, spriteUrl } : null),
    [ready, spriteUrl, loadedUrl]
  )
}
