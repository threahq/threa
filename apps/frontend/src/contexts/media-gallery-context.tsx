import { createContext, useContext, useCallback, useMemo, useRef, type ReactNode } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"

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
  const navigate = useNavigate()

  const mediaAttachmentId = useMemo(() => {
    return searchParams.get("media")
  }, [searchParams])

  // Tracks whether opening the gallery pushed a history entry we can pop on
  // close. False when the gallery was deep-linked (?media= present on load),
  // where there is no entry to go back to without leaving the app.
  const pushedOnOpenRef = useRef(false)

  const openMedia = useCallback(
    (attachmentId: string) => {
      // Opening the gallery deepens history (push) so the OS back button
      // closes it; navigating between items replaces so the back stack
      // doesn't fill with every viewed image.
      const isNavigatingItems = searchParams.get("media") !== null
      if (!isNavigatingItems) pushedOnOpenRef.current = true
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set("media", attachmentId)
          return next
        },
        { replace: isNavigatingItems }
      )
    },
    [searchParams, setSearchParams]
  )

  const closeMedia = useCallback(() => {
    // Closing is "navigating up the tree": pop the entry opening pushed so
    // history stays clean. Deep-linked opens have nothing to pop, so strip
    // the param in place instead of escaping the app.
    if (pushedOnOpenRef.current) {
      pushedOnOpenRef.current = false
      navigate(-1)
      return
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("media")
        return next
      },
      { replace: true }
    )
  }, [navigate, setSearchParams])

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
