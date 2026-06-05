import type { AuthorType } from "@threa/types"
import { Moon } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { PersonaAvatar } from "@/components/persona-avatar"
import { useActors } from "@/hooks"
import { formatNotificationPauseLabel, formatStatusClearLabel } from "@/lib/status"
import { cn } from "@/lib/utils"

type ActorAvatarSize = "xs" | "sm" | "md" | "lg"

/**
 * Size tokens — pixel-perfect so all actor renderings stay visually
 * consistent across the app. `persona` delegates to PersonaAvatar's own
 * size config; we just pass the matching token through.
 */
const SIZE_CLASSES: Record<ActorAvatarSize, string> = {
  xs: "h-5 w-5 rounded-[5px]",
  sm: "h-7 w-7 rounded-[6px]",
  md: "h-8 w-8 rounded-[8px]",
  lg: "h-9 w-9 rounded-[10px]",
}

const FALLBACK_TEXT_CLASSES: Record<ActorAvatarSize, string> = {
  xs: "text-[9px] font-medium",
  sm: "text-xs font-medium",
  md: "text-sm font-medium",
  lg: "text-base font-medium",
}

/** Status-badge glyph size per avatar token. Kept small so it reads as a badge. */
const STATUS_BADGE_CLASSES: Record<ActorAvatarSize, string> = {
  xs: "text-[9px] -right-0.5 -bottom-0.5",
  sm: "text-[11px] -right-0.5 -bottom-0.5",
  md: "text-xs -right-1 -bottom-1",
  lg: "text-sm -right-1 -bottom-1",
}

interface ActorAvatarProps {
  actorId: string | null
  actorType: AuthorType | null
  workspaceId: string
  size?: ActorAvatarSize
  className?: string
  /** alt text for AvatarImage — defaults to "" (decorative). */
  alt?: string
  /**
   * Render the user's status emoji as a corner badge when present. On by
   * default; pass `false` on dense surfaces (e.g. tiny avatar stacks) where the
   * badge would crowd the glyph.
   */
  showStatus?: boolean
}

/**
 * Single entry point for rendering any actor's avatar — users, personas,
 * bots, and system events — so every surface stays visually consistent
 * without reimplementing the `if persona ? PersonaAvatar : Avatar`
 * branching in each callsite.
 *
 * - **Persona**: delegates to `<PersonaAvatar>` which handles Ariadne's
 *   SVG icon + gold inset border.
 * - **Bot**: image when available, emerald-tinted fallback otherwise.
 * - **System**: always fallback with blue tint (no image).
 * - **User**: image when available, muted fallback with initials.
 */
export function ActorAvatar({
  actorId,
  actorType,
  workspaceId,
  size = "md",
  className,
  alt = "",
  showStatus = true,
}: ActorAvatarProps) {
  const { getActorAvatar } = useActors(workspaceId)
  const info = getActorAvatar(actorId, actorType)

  if (actorType === "persona") {
    return <PersonaAvatar slug={info.slug} fallback={info.fallback} size={size} className={className} />
  }

  let fallbackTint = "bg-muted text-foreground"
  if (actorType === "bot") fallbackTint = "bg-emerald-500/10 text-emerald-600"
  else if (actorType === "system") fallbackTint = "bg-blue-500/10 text-blue-500"

  const statusEmoji = showStatus ? info.status?.emoji : null
  // A do-not-disturb badge stands in only when there's no status emoji already
  // signalling it (a DND *status* shows its own glyph) — so a statusless manual
  // pause still surfaces a moon, without double-badging.
  const showDnd = showStatus && !statusEmoji && Boolean(info.dnd)

  const avatar = (
    <Avatar className={cn(SIZE_CLASSES[size], "shrink-0", className)}>
      {info.avatarUrl && <AvatarImage src={info.avatarUrl} alt={alt} />}
      <AvatarFallback className={cn(fallbackTint, FALLBACK_TEXT_CLASSES[size])}>{info.fallback}</AvatarFallback>
    </Avatar>
  )

  // Badge is absolutely positioned over the avatar so it never shifts layout
  // (INV-21). The wrapper is `inline-flex` with no extra box, matching the
  // avatar's footprint.
  if (!statusEmoji && !showDnd) return avatar
  const statusTitle = [info.status?.text, formatStatusClearLabel(info.status?.expiresAt ?? null)]
    .filter(Boolean)
    .join(" · ")
  return (
    <span
      className="relative inline-flex shrink-0"
      title={statusTitle || (showDnd && info.dnd ? formatNotificationPauseLabel(info.dnd) : undefined)}
    >
      {avatar}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute flex items-center justify-center rounded-full bg-background leading-none",
          STATUS_BADGE_CLASSES[size]
        )}
      >
        {statusEmoji ?? <Moon className="h-2.5 w-2.5 text-muted-foreground" />}
      </span>
    </span>
  )
}
