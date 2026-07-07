import { useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { X } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * Lifecycle status shared between file-upload pills and context-ref pills.
 *
 * - `default` — fully resolved (uploaded file, ready/inline context-ref).
 * - `pending` — in-flight (upload progressing, precompute in flight).
 * - `error`   — terminal failure.
 */
export type AttachmentPillStatus = "default" | "pending" | "error"

export interface AttachmentPillProps {
  icon: ComponentType<{ className?: string }>
  label: string
  secondary?: ReactNode
  status?: AttachmentPillStatus
  tooltip?: ReactNode
  /**
   * Small preview image shown in the leading slot in place of `icon` (e.g. an
   * image attachment's thumbnail). Falls back to `icon` if it fails to load —
   * the E2E-locked case, where the deterministic content URL serves ciphertext.
   */
  thumbnailSrc?: string
  /** When provided renders a small × button at the trailing edge. */
  onRemove?: () => void
  /**
   * Makes the pill activate (open a preview) on click / Enter / Space. The pill
   * becomes a `role="button"` so a nested `onRemove` button can still live
   * inside it — a real `<button>` can't nest another button.
   */
  onActivate?: () => void
  /** Internal route — turns the pill into a `<Link>`. */
  href?: string
  removeLabel?: string
  /** Accessible name for the activate affordance (defaults to `label`). */
  activateLabel?: string
  labelMaxWidth?: string
  className?: string
}

const STATUS_STYLES: Record<AttachmentPillStatus, string> = {
  default: "border border-primary/30 bg-card text-primary",
  pending: "border border-dashed border-muted-foreground/40 bg-card text-muted-foreground",
  error: "border border-destructive bg-card text-destructive",
}

const STATUS_REMOVE_HOVER: Record<AttachmentPillStatus, string> = {
  default: "hover:bg-primary/20",
  pending: "hover:bg-muted",
  error: "hover:bg-destructive/20",
}

const SECONDARY_TONE: Record<AttachmentPillStatus, string> = {
  default: "text-primary/70",
  pending: "text-muted-foreground",
  error: "text-destructive/80",
}

function PillLeading({
  icon: Icon,
  thumbnailSrc,
  spin,
}: {
  icon: ComponentType<{ className?: string }>
  thumbnailSrc?: string
  spin: boolean
}) {
  const [failed, setFailed] = useState(false)
  if (thumbnailSrc && !failed) {
    return (
      <img
        src={thumbnailSrc}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className="h-5 w-5 shrink-0 rounded object-cover"
      />
    )
  }
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", spin && "animate-spin")} />
}

/**
 * Canonical pill primitive used by the composer attachment row and the
 * timeline message context-ref badge. Keeps file uploads and context refs
 * visually consistent — same shape, spacing, status palette, and
 * remove + link affordances.
 */
export function AttachmentPill({
  icon,
  label,
  secondary,
  status = "default",
  tooltip,
  thumbnailSrc,
  onRemove,
  onActivate,
  href,
  removeLabel,
  activateLabel,
  labelMaxWidth = "max-w-[160px]",
  className,
}: AttachmentPillProps) {
  // Matches `<Button variant="outline" size="sm" className="h-8 gap-2 text-xs">`,
  // the surface `<AttachmentList>` uses for sent-message file cards, so a chip
  // keeps identical metrics moving from composer to timeline.
  const baseStyles = "inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs select-none"
  const statusStyles = STATUS_STYLES[status]

  const inner = (
    <>
      <PillLeading icon={icon} thumbnailSrc={thumbnailSrc} spin={status === "pending" && !thumbnailSrc} />
      <span className={cn("truncate", labelMaxWidth)}>{label}</span>
      {secondary != null && <span className={SECONDARY_TONE[status]}>{secondary}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onRemove()
          }}
          className={cn(
            "ml-0.5 rounded-full p-0.5 opacity-60 hover:opacity-100 transition-opacity",
            STATUS_REMOVE_HOVER[status]
          )}
          aria-label={removeLabel ?? "Remove"}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </>
  )

  let pill: ReactNode
  if (href) {
    pill = (
      <Link
        to={href}
        className={cn(baseStyles, statusStyles, "cursor-pointer hover:brightness-110 transition-[filter]", className)}
      >
        {inner}
      </Link>
    )
  } else if (onActivate) {
    // role=button (not a real <button>) so the nested remove <button> is valid —
    // buttons can't nest. The keydown guard keeps the nested button's own
    // Enter/Space activation from also firing this activate.
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        onActivate()
      }
    }
    pill = (
      <div
        role="button"
        tabIndex={0}
        aria-label={activateLabel ?? label}
        onClick={onActivate}
        onKeyDown={handleKeyDown}
        className={cn(
          baseStyles,
          statusStyles,
          "cursor-pointer hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          className
        )}
      >
        {inner}
      </div>
    )
  } else {
    pill = <div className={cn(baseStyles, statusStyles, className)}>{inner}</div>
  }

  if (!tooltip) return pill

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{pill}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px]">
          {typeof tooltip === "string" ? <p className="text-sm">{tooltip}</p> : tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
