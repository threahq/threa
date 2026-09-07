import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface SearchRefineStatusProps {
  /** The model's one-line account of the refinement; null when it gave none. */
  note: string | null
  /** The refinement failed twice and the list is unrefined (INV-11). */
  failed: boolean
  onRetry: () => void
  size?: "sm" | "touch"
}

const TEXT_SIZE: Record<NonNullable<SearchRefineStatusProps["size"]>, string> = {
  sm: "text-[11px]",
  touch: "text-xs",
}

const RETRY_SIZE: Record<NonNullable<SearchRefineStatusProps["size"]>, string> = {
  sm: "h-5 px-1.5 text-[11px]",
  touch: "h-8 px-2.5 text-xs",
}

/** What the refinement did to the list, under the result summary on both search surfaces. */
export function SearchRefineStatus({ note, failed, onRetry, size = "sm" }: SearchRefineStatusProps) {
  return (
    <>
      {note && (
        <p className={cn("w-full leading-snug text-muted-foreground", TEXT_SIZE[size])} data-search-refine-note>
          {note}
        </p>
      )}
      {failed && (
        <p
          className={cn("flex w-full flex-wrap items-center gap-x-1 leading-snug text-destructive", TEXT_SIZE[size])}
          data-search-refine-failed
        >
          Couldn&apos;t apply the refinement after two tries. Showing all results.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("text-destructive hover:bg-destructive/10 hover:text-destructive", RETRY_SIZE[size])}
            onClick={onRetry}
          >
            Retry
          </Button>
        </p>
      )}
    </>
  )
}
