import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { AUDIENCE_TONE } from "@/components/editor/reference-audience-tone"
import type { AudienceQuestionCopy, SendWarning } from "@/lib/reference-audience"
import { cn } from "@/lib/utils"

interface SendAskRowProps {
  tone: SendWarning["tone"]
  copy: AudienceQuestionCopy
  compact: boolean
  onPrimary: () => void
  onAlternative?: () => void
  mirrored?: boolean
  className?: string
}

export function SendAskRow({
  tone,
  copy,
  compact,
  onPrimary,
  onAlternative,
  mirrored = false,
  className,
}: SendAskRowProps) {
  const primaryRef = useRef<HTMLButtonElement>(null)
  const questionId = useId()
  useEffect(() => {
    if (!compact) primaryRef.current?.focus()
  }, [compact])

  // Enter is handled on keydown so the browser's synthetic click can't add a
  // second send, and a held key's repeats can't send at all.
  const handlePrimaryKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    if (!event.repeat) onPrimary()
  }

  const Icon = AUDIENCE_TONE[tone].icon
  const alternative = onAlternative ? copy.alternative : undefined

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      data-testid="send-ask"
      data-tone={tone}
      className={cn(
        "flex min-w-0 items-center gap-2 [container-type:inline-size]",
        mirrored && "flex-row-reverse",
        className
      )}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium", AUDIENCE_TONE[tone].text)}>
        <Icon aria-hidden className="h-4 w-4 shrink-0" />
        <span id={questionId} role="status" className="truncate">
          <FitCopy compact={compact} copy={copy} />
        </span>
      </div>
      {alternative && (
        <Button type="button" variant="ghost" size="sm" className="h-[30px] shrink-0 px-2.5" onClick={onAlternative}>
          <FitCopy compact={compact} copy={alternative} />
        </Button>
      )}
      <Button
        ref={primaryRef}
        type="button"
        size="sm"
        className="h-[30px] shrink-0 gap-1.5 px-3"
        aria-describedby={questionId}
        onClick={onPrimary}
        onKeyDown={handlePrimaryKeyDown}
      >
        {copy.primary}
        {!compact && (
          <kbd aria-hidden className="font-sans text-[11px] leading-none opacity-70">
            ↵
          </kbd>
        )}
      </Button>
    </div>
  )
}

/** A split pane is desktop too narrow for the full sentence; there the row falls back to the short copy. */
function FitCopy({ compact, copy }: { compact: boolean; copy: { full: string; short: string } }) {
  if (compact) return copy.short
  return (
    <>
      <span className="hidden [@container(min-width:32rem)]:inline">{copy.full}</span>
      <span className="[@container(min-width:32rem)]:hidden">{copy.short}</span>
    </>
  )
}

export function SendWarningBadge({ tone }: { tone: SendWarning["tone"] }) {
  const Icon = AUDIENCE_TONE[tone].icon
  return (
    <span
      aria-hidden
      data-testid="send-warning-badge"
      data-tone={tone}
      className={cn(
        "pointer-events-none absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full text-white ring-2 ring-background dark:text-background",
        AUDIENCE_TONE[tone].fill
      )}
    >
      <Icon className="!size-[9px]" strokeWidth={3} />
    </span>
  )
}

/** The question takes the footer's place without moving it: the footer stays laid out, hidden, under the row. */
export function AskOverlay({
  askRow,
  className,
  children,
}: {
  askRow: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("relative", className)}>
      <div className={cn(askRow && "invisible")} aria-hidden={askRow ? true : undefined}>
        {children}
      </div>
      {askRow && <div className="absolute inset-0 flex items-center">{askRow}</div>}
    </div>
  )
}
