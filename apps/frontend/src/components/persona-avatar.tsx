import { getPersonaAvatarUrl, type PersonaListItem } from "@threa/types"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { AriadneIcon } from "@/components/ariadne-icon"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { cn } from "@/lib/utils"

/** System persona slug for Ariadne - uses SVG icon instead of emoji */
const ARIADNE_SLUG = "ariadne"

type AvatarSize = "xs" | "sm" | "md" | "lg"

const SIZE_CONFIG: Record<AvatarSize, { avatar: string; icon: "xs" | "sm" | "md"; text: string; border: string }> = {
  xs: {
    avatar: "h-5 w-5 rounded-[5px]",
    icon: "xs",
    text: "text-[9px]",
    border: "shadow-[inset_0_0_0_1px_hsl(var(--primary))]",
  },
  sm: { avatar: "h-7 w-7", icon: "xs", text: "text-xs", border: "shadow-[inset_0_0_0_1px_hsl(var(--primary))]" },
  md: {
    // Matches ActorAvatar `md` (stream view's base avatar — 32px rounded-[8px]).
    avatar: "h-8 w-8 rounded-[8px]",
    icon: "sm",
    text: "text-sm",
    border: "shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]",
  },
  lg: {
    avatar: "h-9 w-9 rounded-[10px]",
    icon: "md",
    text: "text-base",
    border: "shadow-[inset_0_0_0_2px_hsl(var(--primary))]",
  },
}

interface PersonaAvatarProps {
  /** Persona slug (e.g., "ariadne") - used to determine if SVG icon should be rendered */
  slug?: string
  /**
   * Served URL of a custom persona's uploaded avatar image (from
   * `getPersonaAvatarUrl`). When set it renders above the icon/emoji/initials
   * fallback; a built-in (Ariadne) never carries one and keeps its SVG icon.
   */
  avatarUrl?: string
  /** Fallback display: emoji or initials */
  fallback: string
  /** Size variant */
  size?: AvatarSize
  /** Additional className for the Avatar wrapper */
  className?: string
}

/**
 * Avatar component for personas that handles special icons.
 *
 * - For a custom persona with an uploaded image: renders the image (Radix falls
 *   back to the icon/emoji/initials below while it loads or on error)
 * - For Ariadne: renders the AriadneIcon SVG with gold border
 * - For other personas: renders emoji or initials with solid gold background
 *
 * Centralizes the logic for persona avatar rendering so it's consistent
 * across message timeline, mention list, and other UI.
 */
export function PersonaAvatar({ slug, avatarUrl, fallback, size = "md", className }: PersonaAvatarProps) {
  const config = SIZE_CONFIG[size]
  const isAriadne = slug === ARIADNE_SLUG

  return (
    <Avatar className={cn(config.avatar, "shrink-0", className)}>
      {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
      <AvatarFallback className={cn("bg-card text-primary", config.text, config.border)}>
        {isAriadne ? <AriadneIcon size={config.icon} /> : fallback}
      </AvatarFallback>
    </Avatar>
  )
}

/**
 * Check if a persona slug should use an SVG icon instead of emoji.
 * Useful when you need to know before rendering (e.g., for different layouts).
 */
export function personaHasSvgIcon(slug: string | undefined): boolean {
  return slug === ARIADNE_SLUG
}

interface PersonaListAvatarProps {
  workspaceId: string
  persona: Pick<PersonaListItem, "slug" | "name" | "avatarEmoji" | "avatarUrl">
  size?: AvatarSize
  className?: string
}

/**
 * PersonaAvatar for a roster/list row: resolves the served image URL and the
 * emoji-shortcode-or-initial fallback from the list item itself, so list
 * surfaces (settings roster, companion picker) don't each re-derive them.
 */
export function PersonaListAvatar({ workspaceId, persona, size = "md", className }: PersonaListAvatarProps) {
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const fallback =
    (persona.avatarEmoji && (toEmoji(persona.avatarEmoji) ?? persona.avatarEmoji)) || persona.name.charAt(0)
  return (
    <PersonaAvatar
      slug={persona.slug}
      avatarUrl={getPersonaAvatarUrl(workspaceId, persona.avatarUrl, 64)}
      fallback={fallback}
      size={size}
      className={className}
    />
  )
}
