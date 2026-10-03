import { useCallback } from "react"
import { Pencil, RotateCcw, Trash2 } from "lucide-react"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { Separator } from "@/components/ui/separator"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { cn } from "@/lib/utils"

interface UnsentMessageActionDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contentMarkdown: string
  authorName: string
  onEdit: () => void
  onDelete: () => void
  onRetry?: () => void
}

export function UnsentMessageActionDrawer({
  open,
  onOpenChange,
  contentMarkdown,
  authorName,
  onEdit,
  onDelete,
  onRetry,
}: UnsentMessageActionDrawerProps) {
  const handleAction = useCallback(
    (action: () => void) => {
      onOpenChange(false)
      action()
    },
    [onOpenChange]
  )

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85dvh]">
        <DrawerTitle className="sr-only">Message actions</DrawerTitle>

        {/* Message preview */}
        <div className="px-4 pt-1 pb-3">
          <div className="rounded-xl bg-muted/60 px-3.5 py-2.5">
            <p className="text-[13px] font-medium text-muted-foreground mb-0.5">{authorName}</p>
            <div className="text-sm text-foreground/80 line-clamp-2 leading-snug">
              <MarkdownContent content={contentMarkdown} />
            </div>
          </div>
        </div>

        {/* Action list */}
        <div className="px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
          {onRetry && (
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm active:bg-muted/80 transition-colors"
              onClick={() => handleAction(onRetry)}
            >
              <RotateCcw className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
              <span>Retry</span>
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm active:bg-muted/80 transition-colors"
            onClick={() => handleAction(onEdit)}
          >
            <Pencil className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
            <span>Edit</span>
          </button>
          <Separator className="mx-3 my-1 w-auto bg-border/50" />
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
              "text-destructive active:bg-destructive/10"
            )}
            onClick={() => handleAction(onDelete)}
          >
            <Trash2 className="h-[18px] w-[18px] text-destructive shrink-0" />
            <span>Delete</span>
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
