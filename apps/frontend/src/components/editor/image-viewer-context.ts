import { createContext, useContext } from "react"

export interface ImageViewer {
  open: (attachmentId: string) => void
  /** A read-only surface opens an image on tap, where an editable one selects it to offer edits. */
  readOnly: boolean
}

/** Opens an image reference full-screen. Only a surface with a gallery for its images provides it. */
export const ImageViewerContext = createContext<ImageViewer | null>(null)

export function useImageViewer(): ImageViewer | null {
  return useContext(ImageViewerContext)
}
