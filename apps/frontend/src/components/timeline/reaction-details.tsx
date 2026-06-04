import { useEffect, useMemo, useState } from "react"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { useActors, actorTypeFromId } from "@/hooks"
import { useLongPress } from "@/hooks/use-long-press"
import { useIsMobile } from "@/hooks/use-mobile"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { cn } from "@/lib/utils"

interface ReactionDetailsContentProps {
  reactions: Record<string, string[]>
  workspaceId: string
  defaultEmoji?: string | null
}

export function ReactionDetailsContent({ reactions, workspaceId, defaultEmoji = null }: ReactionDetailsContentProps) {
  const { getActorName } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const [selectedEmoji, setSelectedEmoji] = useState<string | null>(defaultEmoji)

  const sortedEntries = useMemo(() => {
    return Object.entries(reactions)
      .filter(([, users]) => users.length > 0)
      .sort((a, b) => b[1].length - a[1].length)
  }, [reactions])

  // Reset selection if the selected emoji's reactions were removed in real-time.
  useEffect(() => {
    if (selectedEmoji && !sortedEntries.some(([sc]) => sc === selectedEmoji)) {
      setSelectedEmoji(null)
    }
  }, [selectedEmoji, sortedEntries])

  const totalCount = useMemo(() => sortedEntries.reduce((sum, [, users]) => sum + users.length, 0), [sortedEntries])

  const displayedUsers = useMemo(() => {
    if (!selectedEmoji) {
      const seen = new Map<string, string[]>()
      for (const [emoji, userIds] of sortedEntries) {
        for (const userId of userIds) {
          const existing = seen.get(userId)
          if (existing) {
            existing.push(emoji)
          } else {
            seen.set(userId, [emoji])
          }
        }
      }
      return Array.from(seen.entries()).map(([userId, emojis]) => ({ userId, emojis }))
    }
    const userIds = reactions[selectedEmoji] ?? []
    return userIds.map((userId) => ({ userId, emojis: [selectedEmoji] }))
  }, [selectedEmoji, sortedEntries, reactions])

  return (
    <>
      {/* Emoji filter tabs */}
      <div className="flex flex-wrap gap-0.5 px-1.5 pt-1.5 pb-1">
        <button
          type="button"
          className={cn(
            "shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors",
            !selectedEmoji ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/80"
          )}
          onClick={() => setSelectedEmoji(null)}
        >
          All {totalCount}
        </button>
        {sortedEntries.map(([shortcode, users]) => {
          const emoji = toEmoji(shortcode)
          return (
            <button
              key={shortcode}
              type="button"
              className={cn(
                "shrink-0 rounded-md px-1.5 py-1 text-xs transition-colors inline-flex items-center gap-0.5",
                selectedEmoji === shortcode ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/80"
              )}
              onClick={() => setSelectedEmoji(shortcode)}
            >
              <span>{emoji ?? shortcode}</span>
              <span className="tabular-nums">{users.length}</span>
            </button>
          )
        })}
      </div>

      <div className="border-t border-border/50" />

      {/* User list */}
      <div className="max-h-[220px] overflow-y-auto py-1 px-1">
        {displayedUsers.map(({ userId, emojis }) => {
          const visibleEmojis = emojis.slice(0, 4)
          const extraCount = emojis.length - visibleEmojis.length
          return (
            <div
              key={userId}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50 transition-colors"
            >
              <span className="truncate flex-1 text-foreground/90">
                {getActorName(userId, actorTypeFromId(userId))}
              </span>
              <span className="shrink-0 text-base flex items-center gap-0.5">
                {visibleEmojis.map((shortcode) => (
                  <span key={shortcode}>{toEmoji(shortcode) ?? shortcode}</span>
                ))}
                {extraCount > 0 && (
                  <span className="text-[11px] text-muted-foreground tabular-nums">+{extraCount}</span>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}

interface ReactionPillDetailsProps {
  emoji: string
  reactions: Record<string, string[]>
  workspaceId: string
  children: React.ReactNode
}

/**
 * Wraps a reaction pill and reveals who reacted:
 * - Desktop: hover opens a HoverCard popover (~350ms delay).
 * - Mobile: long-press opens a bottom Drawer; tap still toggles the reaction.
 *
 * The wrapped child keeps its native click handling in both modes.
 */
export function ReactionPillDetails({ emoji, reactions, workspaceId, children }: ReactionPillDetailsProps) {
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { handlers } = useLongPress({
    enabled: isMobile,
    onLongPress: () => setDrawerOpen(true),
  })

  if (!isMobile) {
    return (
      <HoverCard openDelay={350} closeDelay={120}>
        <HoverCardTrigger asChild>{children}</HoverCardTrigger>
        <HoverCardContent side="top" align="start" className="w-[300px] p-0">
          <ReactionDetailsContent reactions={reactions} workspaceId={workspaceId} defaultEmoji={emoji} />
        </HoverCardContent>
      </HoverCard>
    )
  }

  return (
    <>
      {/* Stop touch propagation so the parent message long-press handler doesn't also fire */}
      <span
        className="contents"
        onTouchStart={(e) => {
          e.stopPropagation()
          handlers.onTouchStart(e)
        }}
        onTouchEnd={handlers.onTouchEnd}
        onTouchMove={(e) => {
          e.stopPropagation()
          handlers.onTouchMove(e)
        }}
        onContextMenu={handlers.onContextMenu}
      >
        {children}
      </span>
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DrawerContent>
          <div className="min-h-[50dvh] flex flex-col">
            <DrawerHeader className="pb-2">
              <DrawerTitle className="text-base">Reactions</DrawerTitle>
              <DrawerDescription className="sr-only">People who reacted to this message</DrawerDescription>
            </DrawerHeader>
            <div className="pb-4 flex-1">
              {/* key forces a fresh mount per open so selectedEmoji resets to this pill's emoji */}
              <ReactionDetailsContent
                key={drawerOpen ? emoji : "closed"}
                reactions={reactions}
                workspaceId={workspaceId}
                defaultEmoji={emoji}
              />
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}
