import type { ChangeEvent } from "react"

interface HandleMobileInlineAttachmentPickerOptions {
  event: ChangeEvent<HTMLInputElement>
  isMobile: boolean
  inlineEnabled: boolean
  insertFiles: (files: File[]) => boolean
  fallback: (event: ChangeEvent<HTMLInputElement>) => void
}

export function handleMobileInlineAttachmentPicker({
  event,
  isMobile,
  inlineEnabled,
  insertFiles,
  fallback,
}: HandleMobileInlineAttachmentPickerOptions): void {
  const files = Array.from(event.target.files ?? [])
  if (!isMobile || !inlineEnabled || files.length === 0 || !insertFiles(files)) {
    fallback(event)
    return
  }
  event.target.value = ""
}
