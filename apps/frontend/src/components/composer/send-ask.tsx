import { useEffect, useRef, type KeyboardEvent } from "react"
import { Eye, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AUDIENCE_TONE_TEXT } from "@/components/editor/reference-audience-context"
import type { AudienceQuestionCopy, SendWarning } from "@/lib/reference-audience"
import { cn } from "@/lib/utils"

const TONE_FILL: Record<SendWarning["tone"], string> = {
  unreachable: "bg-amber-600 dark:bg-amber-400",
  reveal: "bg-sky-600 dark:bg-sky-400",
}

const TONE_ICON = { unreachable: Lock, reveal: Eye } as const

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

  const Icon = TONE_ICON[tone]
  const alternative = onAlternative ? copy.alternative : undefined

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="send-ask"
      data-tone={tone}
      className={cn(
        "flex min-w-0 items-center gap-2 [container-type:inline-size]",
        mirrored && "flex-row-reverse",
        className
      )}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium", AUDIENCE_TONE_TEXT[tone])}>
        <Icon aria-hidden className="h-4 w-4 shrink-0" />
        <span className="truncate">
          <FitCopy compact={compact} wide={copy.desktop} narrow={copy.mobile} />
        </span>
      </div>
      {alternative && (
        <Button type="button" variant="ghost" size="sm" className="h-[30px] shrink-0 px-2.5" onClick={onAlternative}>
          <FitCopy compact={compact} wide={alternative.desktop} narrow={alternative.mobile} />
        </Button>
      )}
      <Button
        ref={primaryRef}
        type="button"
        size="sm"
        className="h-[30px] shrink-0 gap-1.5 px-3"
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

/** A split pane is desktop too narrow for the desktop sentence; there the row falls back to the phone copy. */
function FitCopy({ compact, wide, narrow }: { compact: boolean; wide: string; narrow: string }) {
  if (compact) return narrow
  return (
    <>
      <span className="hidden [@container(min-width:32rem)]:inline">{wide}</span>
      <span className="[@container(min-width:32rem)]:hidden">{narrow}</span>
    </>
  )
}

export function SendWarningBadge({ tone }: { tone: SendWarning["tone"] }) {
  const Icon = TONE_ICON[tone]
  return (
    <span
      aria-hidden
      data-testid="send-warning-badge"
      data-tone={tone}
      className={cn(
        "pointer-events-none absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full text-white ring-2 ring-background dark:text-background",
        TONE_FILL[tone]
      )}
    >
      <Icon className="!size-[9px]" strokeWidth={3} />
    </span>
  )
}
