import type { ChangeEvent } from "react"

interface HandleMobileInlineAttachmentPickerOptions {
  event: ChangeEvent<HTMLInputElement>
  isMobile: boolean
  inlineEnabled: boolean
  /**
   * The pick was started from `/attachment` → "Upload a file…", which asks for
   * an inline reference outright — device and preference don't enter into it.
   */
  forceInline?: boolean
  insertFiles: (files: File[]) => boolean
  fallback: (event: ChangeEvent<HTMLInputElement>) => void
}

export function handleMobileInlineAttachmentPicker({
  event,
  isMobile,
  inlineEnabled,
  forceInline = false,
  insertFiles,
  fallback,
}: HandleMobileInlineAttachmentPickerOptions): void {
  const files = Array.from(event.target.files ?? [])
  const inline = forceInline || (isMobile && inlineEnabled)
  if (!inline || files.length === 0 || !insertFiles(files)) {
    fallback(event)
    return
  }
  event.target.value = ""
}
