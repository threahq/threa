import { Bot as BotIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { cn } from "@/lib/utils"
import { useInviteActor } from "@/hooks/use-invite-actor"
import { useInputMode } from "@/hooks/use-input-mode"
import { useWorkspaceBots, type CachedBot } from "@/stores/workspace-store"
import { StreamTypes } from "@threahq/types"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"

// `shrink-0` + nowrap: these pills live in the header's scrollable chip strip —
// they must keep their size and let the strip scroll, not squish or wrap.
const pillBase =
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold"
const overflowPillClass =
  "shrink-0 border-border bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
// Invited-bot pills share the scratchpad header row with the title, labels, and
// the encryption + Ariadne affordances — an unbounded run of full name pills
// overflows a phone-width header. Cap the visible pills like `LabelStack` does
// and fold the rest into a "+N" pill (INV-21: no layout shift, the count sits
// in place). Each name also truncates so one long bot name can't blow the row.
const VISIBLE_CAP = 2

// A bot's SSK wrap (E2eActor.keyId) is null until the owner unlocks and the
// key-roll wraps the stream key to it — so `keyId` present ⇔ the bot can
// actually decrypt. An invite made while locked lands here as `false` (pending).
function accessLabel(name: string, canRead: boolean): string {
  return canRead ? `${name} can read this encrypted scratchpad` : `${name} is invited; unlock to grant it access`
}

interface InviteBotButtonProps {
  workspaceId: string
  stream: VirtualStream
}

/**
 * Header affordance for inviting a workspace bot (a self-hosted harness like
 * the Pi remote or the Claude Code channel) into an encrypted scratchpad — the
 * owner's deliberate consent act that wraps the stream key to the bot's
 * identity key so it can serve sealed turns (design §2.6). Invited bots render
 * as inert pills (capped, with a "+N" overflow); the picker lists the rest.
 */
export function InviteBotButton({ workspaceId, stream }: InviteBotButtonProps) {
  const { invite, isInviting } = useInviteActor(workspaceId, stream.id)
  const eligible = stream.type === StreamTypes.SCRATCHPAD && !stream.isDraft && stream.e2eEnabled === true
  // Bootstrap-synced visibility: shared bots plus the viewer's OWN personal
  // bots (`listVisibleTo` server-side). The `GET /bots` endpoint this used to
  // query is deliberately shared-only (it feeds the settings tab's shared
  // section), which silently hid personal harness bots — the primary thing an
  // owner invites — from this picker.
  const bots = useWorkspaceBots(workspaceId)

  if (!eligible) return null

  // actorId → whether the SSK is wrapped to this bot yet (can it actually read).
  const wrappedById = new Map(
    (stream.e2eActors ?? []).filter((a) => a.kind === "bot").map((a) => [a.actorId, Boolean(a.keyId)])
  )
  const invited = bots.filter((bot) => wrappedById.has(bot.id))
  const candidates = bots.filter((bot) => !bot.archivedAt && !wrappedById.has(bot.id))
  const visibleInvited = invited.slice(0, VISIBLE_CAP)
  const overflowInvited = invited.slice(VISIBLE_CAP)
  const canRead = (botId: string) => wrappedById.get(botId) === true

  return (
    <>
      {visibleInvited.map((bot) => {
        const label = accessLabel(bot.name, canRead(bot.id))
        return (
          <Tooltip key={bot.id}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  pillBase,
                  "border-border bg-secondary",
                  canRead(bot.id) ? "text-foreground" : "border-dashed text-muted-foreground"
                )}
                aria-label={label}
              >
                <BotIcon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="max-w-[8rem] truncate">{bot.name}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{label}.</TooltipContent>
          </Tooltip>
        )
      })}
      {overflowInvited.length > 0 && <InvitedBotsOverflow bots={overflowInvited} canRead={canRead} />}
      {/* Visible even while locked, mirroring the sibling Ariadne pill: an
          invite made without unlocked owner credentials is recorded and warns
          ("unlock to grant access"), then the owner-wrap repair heals it — so
          the capability is discoverable in the locked state rather than
          vanishing with no cue. Hidden only when there is nothing to offer. */}
      {candidates.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={isInviting}
              aria-label="Invite an agent to this scratchpad"
              className={cn(pillBase, overflowPillClass, "disabled:opacity-60")}
            >
              <BotIcon className="h-3 w-3" aria-hidden="true" />
              <span>{isInviting ? "Inviting…" : "Invite agent"}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal text-muted-foreground">
              An invited agent will be able to read this encrypted scratchpad.
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {candidates.map((bot) => (
              <DropdownMenuItem key={bot.id} onSelect={() => void invite("bot", bot.id)}>
                <span className="mr-1">{bot.avatarEmoji ?? "🤖"}</span>
                {bot.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  )
}

/**
 * The "+N" overflow for invited-bot pills. A hover-only tooltip would hide the
 * folded bot names from touch users entirely (Radix tooltips no-op on touch and
 * a bare span isn't focusable), so this discloses through a tap `Drawer` on
 * touch and a `HoverCard` on mouse — the same input-mode branch `LabelStack`
 * uses — with a focusable `<button>` trigger for keyboard access.
 */
function InvitedBotsOverflow({ bots, canRead }: { bots: CachedBot[]; canRead: (botId: string) => boolean }) {
  const isTouch = useInputMode() === "touch"
  const names = bots.map((b) => b.name).join(", ")
  const trigger = (
    <button
      type="button"
      aria-label={`${bots.length} more agents invited: ${names}`}
      className={cn(pillBase, overflowPillClass)}
    >
      +{bots.length}
    </button>
  )
  const list = (
    <ul className="flex flex-col gap-2">
      {bots.map((bot) => (
        <li key={bot.id} className="flex items-center gap-2 text-sm">
          <BotIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{bot.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {canRead(bot.id) ? "can read" : "unlock to grant"}
          </span>
        </li>
      ))}
    </ul>
  )

  if (isTouch) {
    return (
      <Drawer>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="pb-[env(safe-area-inset-bottom)]">
          <DrawerHeader>
            <DrawerTitle>Agents with access</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-4">{list}</div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <HoverCard openDelay={100} closeDelay={100}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto max-w-xs p-2">
        {list}
      </HoverCardContent>
    </HoverCard>
  )
}
