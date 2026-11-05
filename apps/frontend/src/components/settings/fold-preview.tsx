import type { CSSProperties } from "react"
import { ChevronDown } from "lucide-react"

const SAMPLE_TEXT =
  "Notes from today's planning call: launch moves to Thursday, so support can finish the articles. " +
  "Pricing stays as it is for now. Design wants one more pass on the onboarding screens, and the " +
  "mobile build goes to testers on Tuesday. Marketing holds the announcement until the release notes " +
  "are final. We still owe legal the updated terms, which Sam will send tomorrow. The data migration " +
  "ran clean on staging, so we'll schedule production for the weekend. Next check-in is Monday at ten, " +
  "same room, and please add anything blocking to the doc before then."

// Half the real height keeps every value in the field's range distinct while
// the box stays a preview; past 240px it stops growing.
const PREVIEW_SCALE = 0.5
const PREVIEW_MAX_PX = 240

const FADE_OUT: CSSProperties = {
  maskImage: "linear-gradient(to bottom, black calc(100% - 1.25rem), transparent)",
  WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 1.25rem), transparent)",
}

/**
 * A collapsed message at reading size, showing half of `foldTo` (the height a
 * collapsed message keeps) above “Show more”, so a taller height visibly
 * shows more. Decorative; the number field carries the value.
 */
export function FoldPreview({ foldTo }: { foldTo: number }) {
  const height = Math.min(Math.round(foldTo * PREVIEW_SCALE), PREVIEW_MAX_PX)
  return (
    <div
      aria-hidden
      data-testid="fold-preview"
      className="w-full select-none rounded-md border bg-background px-3 py-2.5 text-sm leading-5 sm:max-w-sm"
    >
      <p data-testid="fold-preview-text" className="overflow-hidden" style={{ height, ...FADE_OUT }}>
        {SAMPLE_TEXT}
      </p>
      <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        Show more
      </p>
    </div>
  )
}
