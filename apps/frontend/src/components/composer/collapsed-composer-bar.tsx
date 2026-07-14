import { type Ref } from "react"
import { Paperclip, Pencil } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ScopeDraftPreview } from "@/hooks"

/**
 * The floating-composer shadow. Imported by `MessageComposer`'s own collapsed
 * bar (message-composer.tsx) too, so the resting affordances and the live
 * composer share one shadow source and can't drift.
 */
export const COLLAPSED_COMPOSER_SHADOW =
  "shadow-[inset_0_1px_0_hsl(33_28%_97%),0_8px_24px_-14px_hsl(28_30%_22%/0.18),0_2px_6px_-2px_hsl(28_30%_22%/0.06)] dark:shadow-[0_8px_24px_-14px_rgb(0_0_0/0.35),0_2px_6px_-2px_rgb(0_0_0/0.12)]"

const CARD_CLASS = cn(
  "flex w-full min-w-0 rounded-[16px] border border-input bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground",
  COLLAPSED_COMPOSER_SHADOW
)

const ROW_CLASS = "flex w-full items-center gap-2 min-h-[30px]"

/**
 * The one collapsed reply affordance shared by every board surface (board-card
 * resting reply, branch tail, sub-topic draft marker). Matches `MessageComposer`'s
 * own mobile collapsed bar (message-composer.tsx:1131-1136) — same card, shadow,
 * padding, and row metrics — so the resting invitations read as the same object
 * as the live composer that replaces them on tap. With a draft it shows the
 * draft's first line; otherwise the placeholder. No send button — these mount the
 * real composer on tap rather than sending in place.
 */
export function CollapsedComposerBar({
  draft,
  placeholder,
  onClick,
  className,
  buttonRef,
}: {
  draft?: ScopeDraftPreview | null
  placeholder: string
  onClick: () => void
  className?: string
  buttonRef?: Ref<HTMLButtonElement>
}) {
  return (
    <button ref={buttonRef} type="button" onClick={onClick} className={cn(CARD_CLASS, className)}>
      <span className={ROW_CLASS}>
        {draft ? (
          <CollapsedDraftPreview draft={draft} />
        ) : (
          <span className="min-w-0 flex-1 truncate">{placeholder}</span>
        )}
      </span>
    </button>
  )
}

/**
 * A collapsed draft's content: its first line, muted to match the baseline
 * preview. The leading `Pencil` is the one deliberate divergence from the mobile
 * composer bar (which carries no draft marker) — it flags "this holds an unsent
 * draft" so a collapse never reads as a discard (round-4 discoverability, Kris
 * 2026-07-13); sized to the row so it stays a marker, not a control.
 */
function CollapsedDraftPreview({ draft }: { draft: ScopeDraftPreview }) {
  return (
    <>
      <Pencil aria-label="Unsent draft" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {draft.preview ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{draft.preview}</span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5 shrink-0" />
          {draft.attachmentCount} attachment{draft.attachmentCount === 1 ? "" : "s"}
        </span>
      )}
    </>
  )
}
