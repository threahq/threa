import { useState, useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Badge } from "@/components/ui/badge"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { RelativeTime } from "@/components/relative-time"
import { useIsMobile } from "@/hooks/use-mobile"
import { useMessageService } from "@/contexts"
import { messageKeys } from "@/api/messages"
import { cn } from "@/lib/utils"
import type { MessageVersion } from "@threahq/types"

interface MessageHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  messageId: string
  workspaceId: string
  messageCreatedAt: string
  currentContent: {
    contentMarkdown: string
    editedAt?: string
  }
}

interface RevisionEntry {
  revisionNumber: number
  isCurrent: boolean
  contentMarkdown: string
  timestamp?: string
}

export function MessageHistoryDialog({
  open,
  onOpenChange,
  messageId,
  workspaceId,
  messageCreatedAt,
  currentContent,
}: MessageHistoryDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const messageService = useMessageService()
  const isMobile = useIsMobile()

  useEffect(() => {
    if (open) setSelectedIndex(0)
  }, [open, messageId])

  const { data: versions = [] } = useQuery({
    queryKey: messageKeys.versions(workspaceId, messageId),
    queryFn: () => messageService.getVersions(workspaceId, messageId),
    enabled: open,
  })

  const revisions: RevisionEntry[] = buildRevisionList(versions, currentContent, messageCreatedAt)
  const selected = revisions[selectedIndex] ?? revisions[0]

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-2xl max-h-[80vh] sm:flex flex-col"
        drawerClassName="flex flex-col"
        aria-describedby={undefined}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Edit history</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        {isMobile ? (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            <div className="flex gap-2 px-4 pb-3 overflow-x-auto">
              {revisions.map((rev, i) => (
                <button
                  key={rev.revisionNumber}
                  onClick={() => setSelectedIndex(i)}
                  className={cn(
                    "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                    i === selectedIndex
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground active:bg-muted/80"
                  )}
                >
                  {rev.isCurrent ? "Current" : `v${rev.revisionNumber}`}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
              {selected && (
                <>
                  {selected.timestamp && (
                    <div className="text-xs text-muted-foreground mb-2">
                      <RelativeTime date={selected.timestamp} />
                    </div>
                  )}
                  <MarkdownContent content={selected.contentMarkdown} className="text-sm leading-relaxed" />
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex gap-4 flex-1 min-h-0 overflow-hidden px-6 pb-6">
            <div className="w-48 shrink-0 border-r pr-4 overflow-y-auto">
              {revisions.map((rev, i) => (
                <button
                  key={rev.revisionNumber}
                  onClick={() => setSelectedIndex(i)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                    i === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted text-muted-foreground"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">Revision {rev.revisionNumber}</span>
                    {rev.isCurrent && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        Current
                      </Badge>
                    )}
                  </div>
                  {rev.timestamp && (
                    <div className="text-xs mt-0.5">
                      <RelativeTime date={rev.timestamp} />
                    </div>
                  )}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto">
              {selected && <MarkdownContent content={selected.contentMarkdown} className="text-sm leading-relaxed" />}
            </div>
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

export function buildRevisionList(
  versions: MessageVersion[],
  currentContent: { contentMarkdown: string; editedAt?: string },
  messageCreatedAt?: string
): RevisionEntry[] {
  const currentRevisionNumber = versions.length + 1

  const revisions: RevisionEntry[] = []

  revisions.push({
    revisionNumber: currentRevisionNumber,
    isCurrent: true,
    contentMarkdown: currentContent.contentMarkdown,
    timestamp: currentContent.editedAt,
  })

  // Shift timestamps so each revision shows when its content was *introduced*,
  // not when the snapshot was taken (which is when the content was replaced).
  // Version 1 was introduced at messageCreatedAt, version N at versions[N-2].createdAt.
  const sortedAsc = [...versions].sort((a, b) => a.versionNumber - b.versionNumber)
  for (let i = sortedAsc.length - 1; i >= 0; i--) {
    const version = sortedAsc[i]
    revisions.push({
      revisionNumber: version.versionNumber,
      isCurrent: false,
      contentMarkdown: version.contentMarkdown,
      timestamp: i === 0 ? messageCreatedAt : sortedAsc[i - 1].createdAt,
    })
  }

  return revisions
}
