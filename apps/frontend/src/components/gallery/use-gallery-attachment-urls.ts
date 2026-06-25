import { useEffect, useState } from "react"
import { attachmentsApi } from "@/api"

/**
 * Which presigned URL the selected gallery item needs. Images and inline Giphy
 * render from deterministic content URLs and need nothing here, so the caller
 * passes `null` for them.
 */
export type GalleryUrlKind = "video" | "document" | null

/**
 * Lazily resolve the presigned URL for the *currently selected* gallery item,
 * memoized per attachment id so re-selecting never refetches.
 *
 * Videos request the `processed` variant and fall back to raw bytes when a
 * transcode was skipped; documents (pdf/markdown/html/text) request the raw
 * download URL. Only the selected item is fetched — off-screen items resolve to
 * `undefined` until the user lands on them, which is all the gallery renders.
 */
export function useGalleryAttachmentUrls(
  workspaceId: string,
  selectedId: string | null,
  kind: GalleryUrlKind
): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!selectedId || !kind || urls.has(selectedId)) return
    const id = selectedId

    let mounted = true
    const store = (url: string) => {
      if (!mounted) return
      setUrls((prev) => {
        const next = new Map(prev)
        next.set(id, url)
        return next
      })
    }

    async function resolve() {
      try {
        if (kind === "video") {
          // Skipped transcodes have no processed variant; fall back to raw bytes
          // so the <video> still streams (S3 Range support).
          try {
            store(await attachmentsApi.getDownloadUrl(workspaceId, id, { variant: "processed" }))
          } catch {
            store(await attachmentsApi.getDownloadUrl(workspaceId, id))
          }
        } else {
          store(await attachmentsApi.getDownloadUrl(workspaceId, id))
        }
      } catch {
        console.error("Failed to resolve gallery attachment URL")
      }
    }

    resolve()
    return () => {
      mounted = false
    }
  }, [workspaceId, selectedId, kind, urls])

  return urls
}
