import { StopCircle, MessageSquarePlus } from "lucide-react"

// Hover tints are inline styles rather than Tailwind arbitrary variants because
// Tailwind JIT can't pick up template-interpolated class names, and these
// colours are only used here.
const STOP_HOVER = {
  border: "hsl(0 72% 51% / 0.45)",
  bg: "hsl(0 72% 51% / 0.08)",
  fg: "hsl(0 72% 51%)",
}
const REDIRECT_HOVER = {
  border: "hsl(var(--primary) / 0.45)",
  bg: "hsl(var(--primary) / 0.08)",
  fg: "hsl(var(--primary))",
}

interface SessionActionButtonProps {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  /**
   * Set to true when the button is rendered inside a clickable wrapper (e.g. the
   * timeline card's outer `<Link>`). Prevents the click from bubbling to the
   * wrapper and accidentally navigating.
   */
  stopPropagation?: boolean
}

function SessionActionButton({
  onClick,
  stopPropagation,
  hover,
  title,
  label,
  icon,
}: SessionActionButtonProps & {
  hover: { border: string; bg: string; fg: string }
  title: string
  label: string
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        if (stopPropagation) {
          e.preventDefault()
          e.stopPropagation()
        }
        onClick(e)
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = hover.border
        e.currentTarget.style.backgroundColor = hover.bg
        e.currentTarget.style.color = hover.fg
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = ""
        e.currentTarget.style.backgroundColor = ""
        e.currentTarget.style.color = ""
      }}
      className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border/80 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-all duration-150"
      title={title}
    >
      {icon}
      {/* Icon-only below `sm`: the pair shares a row with the card title on
          phones, and two full-width labels squeeze it to nothing. aria-label
          keeps the accessible name when the text hides. */}
      <span className="max-sm:hidden">{label}</span>
    </button>
  )
}

/**
 * Compact "Stop" button for a running agent session. Shared between the
 * timeline card and the in-flight trace step card so the two surfaces stay
 * visually identical. Always visible while the session runs (not a
 * hover-reveal) so the interrupt action is discoverable without guessing.
 *
 * Stop is graceful: the session halts at its next safe checkpoint and wraps
 * up with whatever it has, rather than failing.
 */
export function StopSessionButton({ onClick, stopPropagation }: SessionActionButtonProps) {
  return (
    <SessionActionButton
      onClick={onClick}
      stopPropagation={stopPropagation}
      hover={STOP_HOVER}
      title="Stop this session — the agent wraps up with what it has so far"
      label="Stop"
      icon={<StopCircle className="h-3.5 w-3.5" />}
    />
  )
}

/**
 * Compact "Redirect" button for a running agent session. Focuses the stream's
 * composer so the user can type a steering message; the running session folds
 * mid-run messages into its current work (no new backend call needed).
 */
export function RedirectSessionButton({ onClick, stopPropagation }: SessionActionButtonProps) {
  return (
    <SessionActionButton
      onClick={onClick}
      stopPropagation={stopPropagation}
      hover={REDIRECT_HOVER}
      title="Steer this session — your next message is folded into the current work"
      label="Redirect"
      icon={<MessageSquarePlus className="h-3.5 w-3.5" />}
    />
  )
}
