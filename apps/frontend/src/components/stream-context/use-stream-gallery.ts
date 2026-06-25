import { useCallback, useMemo, useRef } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"

/**
 * Open/close state for the stream-context gallery, encoded in `?smedia=<key>`.
 *
 * Deliberately a separate param from the per-message gallery's `?media=`
 * (media-gallery-context.tsx): that one is claimed by whichever rendered
 * message owns the attachment, and its navigable set is that message's
 * attachments. This gallery is opened from the "In this stream" panel and its
 * set is every media/file item in the stream, so the two must not contend for
 * the same param. The key is an attachment id (uploads) or a `giphy:<url>`
 * sentinel (inline GIFs).
 *
 * History mirrors the per-message gallery: opening pushes (so the OS back
 * button closes), stepping between items replaces (so the back stack doesn't
 * fill), and closing pops the pushed entry — or strips the param in place when
 * the gallery was deep-linked (no entry to pop).
 */
export function useStreamGallery(): {
  selectedKey: string | null
  openGallery: (key: string) => void
  closeGallery: () => void
} {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  const selectedKey = useMemo(() => searchParams.get("smedia"), [searchParams])

  const pushedOnOpenRef = useRef(false)

  const openGallery = useCallback(
    (key: string) => {
      const isNavigatingItems = searchParams.get("smedia") !== null
      if (!isNavigatingItems) pushedOnOpenRef.current = true
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set("smedia", key)
          return next
        },
        { replace: isNavigatingItems }
      )
    },
    [searchParams, setSearchParams]
  )

  const closeGallery = useCallback(() => {
    if (pushedOnOpenRef.current) {
      pushedOnOpenRef.current = false
      navigate(-1)
      return
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("smedia")
        return next
      },
      { replace: true }
    )
  }, [navigate, setSearchParams])

  return useMemo(() => ({ selectedKey, openGallery, closeGallery }), [selectedKey, openGallery, closeGallery])
}
