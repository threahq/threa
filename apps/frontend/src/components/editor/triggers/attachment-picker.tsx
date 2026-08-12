import { forwardRef } from "react"
import type { Placement } from "@floating-ui/react"
import { Paperclip, Upload } from "lucide-react"
import { SuggestionList, type SuggestionListRef } from "./suggestion-list"
import { formatFileSize } from "@/lib/file-size"
import type { AttachmentPickerOption } from "./attachment-picker-options"
import { attachmentPickerOptionKey } from "./attachment-picker-options"

export type AttachmentPickerRef = SuggestionListRef

interface AttachmentPickerProps {
  items: AttachmentPickerOption[]
  clientRect: (() => DOMRect | null) | null
  command: (item: AttachmentPickerOption) => void
  placement?: Placement
  /** The typed filter. Changing it re-ranks the list, so the highlight resets. */
  query: string
}

function AttachmentOptionContent({ item }: { item: AttachmentPickerOption }) {
  const isUpload = item.kind === "upload"
  const Icon = isUpload ? Upload : Paperclip
  const primary = isUpload ? "Upload a file…" : item.attachment.filename
  const secondary = isUpload ? "Pick a file from this device" : formatFileSize(item.attachment.sizeBytes)
  return (
    <>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex flex-1 flex-col items-start min-w-0 overflow-hidden">
        <span className="text-[13px] font-medium truncate w-full">{primary}</span>
        <span className="text-xs text-muted-foreground truncate w-full">{secondary}</span>
      </div>
    </>
  )
}

/**
 * Picker for `/attachment`: the composer's current tray plus a fresh upload.
 * Built on the same `SuggestionList` as the @mention / /command popovers.
 */
export const AttachmentPicker = forwardRef<AttachmentPickerRef, AttachmentPickerProps>(function AttachmentPicker(
  { items, clientRect, command, placement, query },
  ref
) {
  return (
    <SuggestionList
      ref={ref}
      items={items}
      clientRect={clientRect}
      command={command}
      getKey={attachmentPickerOptionKey}
      ariaLabel="Attachment suggestions"
      width="w-[300px]"
      renderItem={(item) => <AttachmentOptionContent item={item} />}
      placement={placement}
      highlightResetKey={query}
    />
  )
})
