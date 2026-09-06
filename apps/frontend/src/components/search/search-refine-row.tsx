import { useEffect, useRef, useState } from "react"
import { Sparkles, X } from "lucide-react"
import { MAX_SEARCH_REFINE_CHARS } from "@threahq/types"
import { cn } from "@/lib/utils"

export type SearchRefineSize = "sm" | "touch"

interface SearchRefineRowProps {
  /** Text the field opens with — a chip's prose when editing one, else empty. */
  initialValue?: string
  onCommit: (text: string) => void
  onClose: () => void
  size?: SearchRefineSize
}

const GROUP_HEIGHT: Record<SearchRefineSize, string> = {
  sm: "min-h-8",
  touch: "min-h-10",
}

const SEGMENT_WIDTH: Record<SearchRefineSize, string> = {
  sm: "w-8",
  touch: "w-10",
}

const FIELD_TEXT: Record<SearchRefineSize, string> = {
  sm: "text-[13px]",
  touch: "text-sm",
}

/**
 * One fused control for a plain-language refinement: the field plus a commit
 * and a close segment inside a single border.
 */
export function SearchRefineRow({ initialValue = "", onCommit, onClose, size = "sm" }: SearchRefineRowProps) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const trimmed = value.trim()
  const tooLong = trimmed.length > MAX_SEARCH_REFINE_CHARS
  const canCommit = trimmed.length > 0 && !tooLong

  const commit = () => {
    if (!canCommit) return
    onCommit(trimmed)
  }

  return (
    // The search surfaces read ArrowUp/ArrowDown/Escape off their container to
    // drive result navigation; keys typed in here must not reach them.
    <div
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Escape") {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <div
        className={cn(
          "flex items-stretch overflow-hidden rounded-md border border-border bg-background transition-colors focus-within:border-primary/60",
          GROUP_HEIGHT[size]
        )}
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            commit()
          }}
          placeholder="Keep, drop, or reorder in plain words"
          aria-label="Refinement"
          className={cn(
            "min-w-0 flex-1 bg-transparent px-2.5 outline-none placeholder:text-muted-foreground/60",
            FIELD_TEXT[size]
          )}
        />
        <button
          type="button"
          aria-label="Apply refinement"
          disabled={!canCommit}
          onClick={commit}
          className={cn(
            "flex shrink-0 items-center justify-center bg-primary text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-50",
            SEGMENT_WIDTH[size]
          )}
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Close refine"
          onClick={onClose}
          className={cn(
            "flex shrink-0 items-center justify-center bg-muted text-muted-foreground transition-colors hover:text-foreground",
            SEGMENT_WIDTH[size]
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {tooLong && (
        <p className="mt-1 text-[11px] leading-snug text-destructive">
          A refinement is at most {MAX_SEARCH_REFINE_CHARS} characters.
        </p>
      )}
    </div>
  )
}
