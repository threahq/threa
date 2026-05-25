import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { categoryFromMime } from "@threa/types"
import { Hash, ExternalLink } from "lucide-react"
import { attachmentsApi, type AttachmentSearchItem } from "@/api/attachments"
import { useFormattedDate } from "@/hooks"
import { formatFileSize } from "@/lib/file-size"
import { cn } from "@/lib/utils"
import { CATEGORY_META } from "./category"

interface ExplorerRowProps {
  workspaceId: string
  item: AttachmentSearchItem
  isSelected: boolean
  onSelect: (id: string) => void
}

export function ExplorerRow({ workspaceId, item, isSelected, onSelect }: ExplorerRowProps) {
  const { formatTime, formatRelative } = useFormattedDate()
  const category = categoryFromMime(item.mimeType)
  const meta = CATEGORY_META[category]
  const Icon = meta.icon

  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  useEffect(() => {
    if (category !== "image") return
    let cancelled = false
    attachmentsApi
      .getDownloadUrl(workspaceId, item.id, { variant: "thumbnail" })
      .then((url) => {
        if (!cancelled) setThumbnailUrl(url)
      })
      .catch(() => {
        // Thumbnail failures fall back to the category icon — the preview
        // pane retries and surfaces the error there.
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, item.id, category])

  const createdAt = new Date(item.createdAt)
  const sourceUrl = item.streamId && item.messageId ? `/w/${workspaceId}/s/${item.streamId}?m=${item.messageId}` : null

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={cn(
        "group/row flex w-full items-center gap-3 rounded-item px-3 py-2 text-left transition-colors",
        "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isSelected && "bg-muted"
      )}
      aria-pressed={isSelected}
    >
      <div
        className={cn(
          "flex h-8 w-8 flex-none items-center justify-center overflow-hidden rounded-md",
          !thumbnailUrl && meta.accent
        )}
      >
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Icon className="h-4 w-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.filename}</div>
        <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          {item.streamSlug ? (
            <>
              <Hash className="h-3 w-3 flex-none" />
              <span className="truncate">{item.streamSlug}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          {item.uploaderName ? (
            <>
              <span className="truncate">{item.uploaderName}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span className="flex-none" title={formatTime(createdAt)}>
            {formatRelative(createdAt, undefined, { terse: true })}
          </span>
          <span aria-hidden>·</span>
          <span className="flex-none">{formatFileSize(item.sizeBytes)}</span>
        </div>
      </div>
      {sourceUrl ? (
        <Link
          to={sourceUrl}
          onClick={(e) => e.stopPropagation()}
          className="flex-none rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover/row:opacity-100 focus-visible:opacity-100"
          aria-label={`Open in #${item.streamSlug ?? "stream"}`}
          title={`Open in #${item.streamSlug ?? "stream"}`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      ) : null}
    </button>
  )
}
