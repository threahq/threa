import { useCallback, useState, type ReactNode } from "react"
import { Check, ChevronUp, Layers, Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { useIsMobile } from "@/hooks/use-mobile"
import type { ConversationWithStaleness } from "@threa/types"
import { conversationColor, type ConversationOverlayContext, type ConversationRowAnnotation } from "./model"
import { ConversationOverlayRowProvider } from "./row-context"

/**
 * Floating panel listing the conversations that currently have message rows
 * on screen (fed by the overlay's IntersectionObserver tracking). Anchored
 * bottom-right above the composer — the top-right corner belongs to the
 * per-row topic chips, which scroll with the timeline and would slide under
 * a top-anchored panel. Absolutely positioned (INV-21: toggling the overlay
 * never reflows the timeline), collapsible to a compact pill — collapsed by
 * default on mobile where space is scarce. Rows toggle focus on a
 * conversation; X closes the overlay (drops the URL param).
 */
export function ConversationOverlayPanel({
  overlay,
  inViewConversations,
  onClose,
}: {
  overlay: ConversationOverlayContext
  inViewConversations: ConversationWithStaleness[]
  onClose: () => void
}) {
  const isMobile = useIsMobile()
  // Collapsed by default on mobile; the user's explicit choice wins once made.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null)
  const collapsed = userCollapsed ?? isMobile
  const { model, focusedConversationId, onToggleFocus } = overlay

  return (
    <div
      data-testid="conversation-overlay-panel"
      className="absolute right-2 z-20 flex justify-end"
      // --composer-height measures the floating pill itself; the pill also
      // floats above the container bottom and has the send-hint line under
      // it, so a plain +0.5rem (what Jump-to-latest uses, which sits flush
      // against the pill) would leave the panel's lower rows behind the
      // composer. 2.5rem clears the pill's own bottom offset with breathing
      // room.
      style={{ bottom: "calc(var(--composer-height, 0px) + 2.5rem)" }}
    >
      {collapsed ? (
        <button
          type="button"
          aria-label="Show conversations in view"
          onClick={() => setUserCollapsed(false)}
          className="flex items-center gap-1.5 rounded-full border border-border/60 bg-background/95 px-2.5 py-1.5 shadow-md backdrop-blur-sm transition-colors hover:bg-accent"
        >
          <Layers className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {inViewConversations.slice(0, 6).map((conversation) => (
            <span
              key={conversation.id}
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: conversationColor(model.colorIndexById.get(conversation.id) ?? 0) }}
            />
          ))}
        </button>
      ) : (
        <div className="w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border/60 bg-popover/95 shadow-lg backdrop-blur-sm">
          <div className="flex items-center gap-0.5 border-b border-border/40 py-1 pl-3 pr-1">
            <span className="flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Conversations in view
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 rounded-full"
              onClick={() => setUserCollapsed(true)}
              aria-label="Collapse conversations panel"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 rounded-full"
              onClick={onClose}
              aria-label="Hide conversation overlay"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto p-1 scrollbar-thin">
            {inViewConversations.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {model.conversations.length === 0 ? "No conversations detected yet" : "No conversations in view"}
              </p>
            ) : (
              inViewConversations.map((conversation) => {
                const colorIndex = model.colorIndexById.get(conversation.id) ?? 0
                const isFocused = focusedConversationId === conversation.id
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => onToggleFocus(conversation.id)}
                    aria-pressed={isFocused}
                    title={conversation.topicSummary ?? undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                      isFocused && "font-medium",
                      focusedConversationId != null && !isFocused && "opacity-50"
                    )}
                    style={isFocused ? { backgroundColor: conversationColor(colorIndex, 0.12) } : undefined}
                  >
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: conversationColor(colorIndex) }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {conversation.topicSummary || "Untitled conversation"}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {conversation.messageIds.length}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Hue strip + wash painted over a message row. Pointer-transparent.
 * Unassigned rows (`colorIndex` null) render no decoration at all: a marker
 * can't distinguish "extraction pending" from "conversation outside the
 * fetched window", and scrolled-back history made every old row light up
 * with it — pure noise.
 */
function RowTint({ colorIndex }: { colorIndex: number | null }) {
  if (colorIndex == null) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundColor: conversationColor(colorIndex, 0.045),
        boxShadow: `inset 3px 0 0 ${conversationColor(colorIndex, 0.7)}`,
      }}
    />
  )
}

/**
 * Wraps one message row while the conversation overlay is active:
 *
 * - hue rail + soft wash for the row's primary conversation (no decoration
 *   when unassigned)
 * - dimming when another conversation is focused via the in-view panel
 * - a hover swatch on the rail that opens the correction menu ("this belongs
 *   to …"), feeding boundary-extraction feedback
 * - registers the row with the overlay's IntersectionObserver so the
 *   in-view panel knows which conversations are on screen
 *
 * All decoration is absolutely positioned — the message itself never moves
 * when the overlay toggles (INV-21).
 */
export function ConversationOverlayRow({
  overlay,
  annotation,
  messageId,
  children,
}: {
  overlay: ConversationOverlayContext
  annotation: ConversationRowAnnotation
  messageId: string
  children: ReactNode
}) {
  const { model, focusedConversationId, onReassignMessage, pendingMessageId, observeRow } = overlay
  const conversation = annotation.conversationId ? model.conversationsById.get(annotation.conversationId) : undefined
  const conversationId = conversation?.id ?? null
  const colorIndex = conversation ? (model.colorIndexById.get(conversation.id) ?? 0) : null
  const isDimmed = focusedConversationId != null && annotation.conversationId !== focusedConversationId
  const isPending = pendingMessageId === messageId

  // React 19 ref-callback cleanup: registration is undone when the row
  // unmounts or its conversation changes (reassignment). MUST be memoized —
  // an inline ref callback gets a fresh identity every render, so React
  // re-runs cleanup+register each time. Registering empties then async-refills
  // the observer's visible set, and the resulting panel state update renders
  // this row again — an oscillation that keeps the in-view panel empty.
  const registerRow = useCallback(
    (element: HTMLElement | null) => {
      if (!element || !conversationId) return
      return observeRow(element, conversationId)
    },
    [observeRow, conversationId]
  )

  return (
    <div className={cn("transition-opacity duration-200", isDimmed && "opacity-40 saturate-50")}>
      <div data-testid="conversation-overlay-row" className="group/convrow relative" ref={registerRow}>
        {/* Row context lets the message action menu/drawer (deep inside
            children) surface the "Move to conversation…" correction — the
            touch path to what the desktop hover swatch below does. */}
        <ConversationOverlayRowProvider overlay={overlay} annotation={annotation}>
          {children}
        </ConversationOverlayRowProvider>
        <RowTint colorIndex={colorIndex} />
        {annotation.blockStart && conversation && colorIndex != null && (
          // Floating topic label on the first message of each contiguous
          // block. Absolutely positioned over the row's top-right corner so
          // it adds no height (INV-21) — toggling the overlay must not move
          // a single message. Purely informational (focus/corrections live
          // in the panel and the rail swatch); fades on row hover to hand
          // the corner to the message hover toolbar. Desktop-only: on
          // mobile's dense header line the chip covers the timestamp, and
          // the rails + panel already carry the grouping there.
          <span
            data-testid="conversation-block-chip"
            title={conversation.topicSummary ?? undefined}
            className={cn(
              "pointer-events-none absolute right-3 top-1.5 z-[5] sm:right-4",
              "hidden max-w-[40%] items-center gap-1.5 rounded-full border px-2 py-0.5 sm:inline-flex",
              "bg-background/85 text-[10px] font-medium leading-4 shadow-sm backdrop-blur-sm",
              "transition-opacity group-hover/convrow:opacity-0"
            )}
            style={{
              borderColor: conversationColor(colorIndex, 0.35),
              color: conversationColor(colorIndex),
            }}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: conversationColor(colorIndex) }}
            />
            <span className="truncate">{conversation.topicSummary || "Untitled conversation"}</span>
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Correct conversation for this message"
              title="Correct conversation"
              className={cn(
                "absolute left-1 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full",
                "border border-border/60 bg-popover shadow-sm sm:flex",
                "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/convrow:opacity-100",
                "data-[state=open]:opacity-100",
                isPending && "opacity-100"
              )}
            >
              {isPending ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : (
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor:
                      colorIndex != null ? conversationColor(colorIndex) : "hsl(var(--muted-foreground) / 0.5)",
                  }}
                />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" className="w-64">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              This message belongs to…
            </DropdownMenuLabel>
            {model.conversations.map((candidate) => {
              const isCurrent = candidate.id === annotation.conversationId
              const candidateColorIndex = model.colorIndexById.get(candidate.id) ?? 0
              return (
                <DropdownMenuItem
                  key={candidate.id}
                  disabled={isCurrent || isPending}
                  onSelect={() => onReassignMessage(messageId, candidate.id)}
                  className="gap-2"
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: conversationColor(candidateColorIndex) }}
                  />
                  <span className="flex-1 truncate">{candidate.topicSummary || "Untitled conversation"}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {candidate.messageIds.length}
                  </span>
                  {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * Bottom-sheet variant of the rail swatch's correction menu, opened from the
 * message action drawer (mobile long-press) or the message ⋯ menu via the
 * "Move to conversation…" action — touch devices have no hover to reveal the
 * swatch. Same semantics: pick the conversation this message belongs to.
 */
export function ConversationPickerDrawer({
  open,
  onOpenChange,
  overlay,
  annotation,
  messageId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  overlay: ConversationOverlayContext
  annotation: ConversationRowAnnotation
  messageId: string
}) {
  const { model, onReassignMessage, pendingMessageId } = overlay
  // Mirror the rail swatch menu: ignore picks while this message's
  // reassignment is already in flight, so rapid taps can't enqueue
  // duplicate corrections.
  const isPending = pendingMessageId === messageId
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerTitle className="px-5 pb-2 pt-1 text-sm font-semibold">This message belongs to…</DrawerTitle>
        <div className="max-h-[60dvh] overflow-y-auto px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
          {model.conversations.map((candidate) => {
            const isCurrent = candidate.id === annotation.conversationId
            const colorIndex = model.colorIndexById.get(candidate.id) ?? 0
            return (
              <button
                key={candidate.id}
                type="button"
                disabled={isCurrent || isPending}
                onClick={() => {
                  if (isCurrent || isPending) return
                  onOpenChange(false)
                  onReassignMessage(messageId, candidate.id)
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                  isCurrent || isPending ? "opacity-60" : "active:bg-muted/80"
                )}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: conversationColor(colorIndex) }}
                />
                <span className="min-w-0 flex-1 truncate">{candidate.topicSummary || "Untitled conversation"}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {candidate.messageIds.length}
                </span>
                {isCurrent && <Check className="h-4 w-4 shrink-0 text-muted-foreground" />}
              </button>
            )
          })}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
