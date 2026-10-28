import { useRef, useState, type KeyboardEvent } from "react"
import { Sparkles } from "lucide-react"
import { toast } from "sonner"
import { StreamTypes } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useRenameStream } from "@/hooks/use-rename-stream"
import { isProtectedRegenerableTitle, useRegenerateTitle } from "@/hooks/use-regenerate-title"
import { useStreamFromStore } from "@/stores/stream-store"
import type { CachedStream } from "@/stores/workspace-store"
import { streamFallbackLabel } from "@/lib/streams"
import { cn } from "@/lib/utils"

const TITLE_CLASS = "text-3xl font-semibold tracking-tight"
const MAX_TITLE_LENGTH = 100
const UNTITLED = streamFallbackLabel(StreamTypes.DOC, "generic")

const pickTitle = (row: CachedStream) => ({
  displayName: row.displayName,
  displayNameSource: row.displayNameSource ?? null,
})

interface DocTitleProps {
  workspaceId: string
  docId: string
  canWrite: boolean
  /** Enter in the title hands the caret to the body. */
  onSubmit: () => void
  className?: string
}

/** The doc's title is its stream's display name, edited in place above the body. */
export function DocTitle({ workspaceId, docId, canWrite, onSubmit, className }: DocTitleProps) {
  const stream = useStreamFromStore(workspaceId, docId, pickTitle)
  const { rename, isPending } = useRenameStream(workspaceId, docId)
  const current = stream?.displayName ?? ""
  const regeneration = useRegenerateTitle(workspaceId, { kind: "stream", stream: { id: docId }, currentTitle: current })
  const [draft, setDraft] = useState<string | null>(null)
  const discardOnBlurRef = useRef(false)

  if (!stream) {
    return (
      <div aria-hidden="true" className={cn(TITLE_CLASS, "invisible", className)}>
        &nbsp;
      </div>
    )
  }

  if (!canWrite) {
    return (
      <h1 className={cn(TITLE_CLASS, !stream.displayName && "text-muted-foreground", className)}>
        {stream.displayName || UNTITLED}
      </h1>
    )
  }

  const commit = async () => {
    if (discardOnBlurRef.current) {
      discardOnBlurRef.current = false
      setDraft(null)
      return
    }
    const next = draft?.trim()
    if (!next || next === current) {
      setDraft(null)
      return
    }
    try {
      await rename(next)
    } catch {
      toast.error("Couldn't rename the doc")
      return
    }
    setDraft(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter") {
      event.preventDefault()
      event.currentTarget.blur()
      onSubmit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      discardOnBlurRef.current = true
      event.currentTarget.blur()
    }
  }

  return (
    <div className={cn("flex items-start gap-2", className)}>
      <input
        aria-label="Doc title"
        placeholder={UNTITLED}
        maxLength={MAX_TITLE_LENGTH}
        value={draft ?? current}
        disabled={isPending}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
        className={cn(TITLE_CLASS, "min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60")}
      />
      {isProtectedRegenerableTitle(stream.displayName, stream.displayNameSource) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Regenerate title"
              className="-my-0.5"
              disabled={regeneration.isPending}
              onClick={() => void regeneration.regenerate().catch(() => undefined)}
            >
              <Sparkles />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Regenerate title</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
