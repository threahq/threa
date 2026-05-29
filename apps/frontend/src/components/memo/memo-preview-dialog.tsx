import { BookOpen, ExternalLink } from "lucide-react"
import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useMemoDetail } from "@/hooks/use-memos"
import { MemoDetailContent } from "@/components/memo/memo-detail"

interface MemoPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  memoId: string
  /** Title parsed from the inline reference; shown while the memo resolves. */
  fallbackTitle: string
}

/**
 * In-stream preview of a referenced memo — a centered modal on desktop, a
 * snap-pointed drawer on mobile (via `ResponsiveDialog`). Reuses the memory
 * explorer's `MemoDetailContent`, so the rendered memo matches the explorer
 * page exactly. Shares the `memoKeys.detail` cache with the embed card's
 * resolver, so opening a card whose memo already resolved is instant. The
 * footer links through to the full memory explorer.
 */
export function MemoPreviewDialog({ open, onOpenChange, workspaceId, memoId, fallbackTitle }: MemoPreviewDialogProps) {
  // Only fetch once opened; shares the detail cache key with the embed card.
  const { data, isLoading } = useMemoDetail(workspaceId, open ? memoId : null)
  const detail = data?.memo ?? null
  // Settled with nothing to show — the memo 404'd (archived / no access) or
  // otherwise resolved empty. Covers `isError` since the query yields no data
  // then. We never fall through to `MemoDetailContent`'s explorer-flavored
  // "Select a memo" empty state in the dialog context.
  const unavailable = !isLoading && !detail

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-2xl max-h-[85vh] sm:flex flex-col gap-0 p-0"
        drawerClassName="flex flex-col"
        aria-describedby={undefined}
      >
        <ResponsiveDialogHeader className="border-b px-4 py-3 sm:px-6">
          <ResponsiveDialogTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />
            {detail?.memo.title || fallbackTitle || "Memo"}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody data-vaul-no-drag className="min-w-0 py-5 sm:py-6">
          {unavailable ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 rounded-full bg-muted/50 p-4">
                <BookOpen className="h-6 w-6 text-muted-foreground/30" />
              </div>
              <p className="text-sm font-medium text-muted-foreground/70">Memo no longer available</p>
              <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground/50">
                It may have been archived or you no longer have access to it.
              </p>
            </div>
          ) : (
            <MemoDetailContent data={detail} workspaceId={workspaceId} isLoading={isLoading} />
          )}
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter className="border-t px-4 py-3 sm:px-6">
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to={`/w/${workspaceId}/memory?memo=${memoId}`} onClick={() => onOpenChange(false)}>
              Open in memory
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
