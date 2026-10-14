import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { useCoverClose } from "@/hooks/use-cover-close"
import { MEDIA_COVER } from "@/lib/covers"
import { useLatest } from "@/hooks/use-latest"

interface MediaGalleryContextValue {
  /** Attachment ID from the ?media= search param, or null */
  mediaAttachmentId: string | null
  openMedia: (attachmentId: string) => void
  closeMedia: () => void
}

const MediaGalleryContext = createContext<MediaGalleryContextValue | null>(null)

interface MediaGalleryProviderProps {
  children: ReactNode
}

export function MediaGalleryProvider({ children }: MediaGalleryProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams()

  const mediaAttachmentId = useMemo(() => {
    return searchParams.get("media")
  }, [searchParams])

  const close = useCoverClose(MEDIA_COVER)
  // The callbacks read the route when called, so the value changes only with
  // the open item: every rendered message holds an attachment provider on it.
  const latest = useLatest({ searchParams, setSearchParams, close })

  const openMedia = useCallback(
    (attachmentId: string) => {
      const { searchParams, setSearchParams } = latest()
      // Opening the gallery deepens history (push) so the OS back button
      // closes it; navigating between items replaces so the back stack
      // doesn't fill with every viewed image.
      const isNavigatingItems = searchParams.get("media") !== null
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set("media", attachmentId)
          return next
        },
        { replace: isNavigatingItems }
      )
    },
    [latest]
  )

  const closeMedia = useCallback(() => latest().close(), [latest])

  const value = useMemo<MediaGalleryContextValue>(
    () => ({
      mediaAttachmentId,
      openMedia,
      closeMedia,
    }),
    [mediaAttachmentId, openMedia, closeMedia]
  )

  return <MediaGalleryContext.Provider value={value}>{children}</MediaGalleryContext.Provider>
}

export function useMediaGallery(): MediaGalleryContextValue {
  const context = useContext(MediaGalleryContext)
  if (!context) {
    throw new Error("useMediaGallery must be used within a MediaGalleryProvider")
  }
  return context
}
