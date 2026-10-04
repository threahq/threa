import { Bell, FileEdit, Hash, MessageSquareText, User, UsersRound, type LucideIcon } from "lucide-react"
import { StreamTypes, type Visibility } from "@threahq/types"

export const GuestPublicIcon = UsersRound

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: "Public",
  guest_public: "Open to guests",
  private: "Private",
}

/**
 * The leading visual for a stream type — glyph + tile tint. The single source of
 * truth shared by the sidebar row (`StreamItem`) and the board card so the two
 * can't drift: a DM shows the peer avatar over this tile, everything else shows
 * the glyph. Colors mirror the sidebar's original per-type mapping.
 */
export interface StreamTypeVisual {
  Icon: LucideIcon
  /** Tailwind classes for the icon tile: background tint + icon color. */
  tileClassName: string
}

export function streamTypeVisual(type: string | undefined): StreamTypeVisual {
  switch (type) {
    case StreamTypes.CHANNEL:
      return { Icon: Hash, tileClassName: "bg-muted text-[hsl(200_60%_50%)]" }
    case StreamTypes.SCRATCHPAD:
      return { Icon: FileEdit, tileClassName: "bg-primary/10 text-primary" }
    case StreamTypes.SYSTEM:
      return { Icon: Bell, tileClassName: "bg-blue-500/10 text-blue-500" }
    case StreamTypes.THREAD:
      return { Icon: MessageSquareText, tileClassName: "bg-muted text-muted-foreground" }
    case StreamTypes.DM:
      return { Icon: User, tileClassName: "bg-muted text-muted-foreground" }
    default:
      return { Icon: MessageSquareText, tileClassName: "bg-muted text-muted-foreground" }
  }
}
