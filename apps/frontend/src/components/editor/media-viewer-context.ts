import { createContext, useContext } from "react"

export interface MediaViewer {
  open: (attachmentId: string) => void
  /** A read-only surface opens an attachment on tap, where an editable one selects it to offer edits. */
  readOnly: boolean
}

/**
 * Opens attachment references in the surface's gallery, and marks a surface that draws its images and videos as
 * full-width media. Only the doc pane provides it: a message draws a rendered video as its chip.
 */
export const MediaViewerContext = createContext<MediaViewer | null>(null)

export function useMediaViewer(): MediaViewer | null {
  return useContext(MediaViewerContext)
}
