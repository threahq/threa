import type { ReactNode } from "react"
import { Check, Loader2, MessagesSquare, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ConversationWithStaleness } from "@threa/types"
import { conversationColor, type ConversationOverlayContext, type ConversationRowAnnotation } from "./model"

/**
 * Pill chip for one conversation: hue dot, topic, message count. Used both
 * at block starts in the timeline and inside the floating legend. Clicking
 * toggles focus on the conversation (dims everything else).
 */
function ConversationChip({
  conversation,
  colorIndex,
  isFocused,
  onToggleFocus,
  className,
}: {
  conversation: ConversationWithStaleness
  colorIndex: number
  isFocused: boolean
  onToggleFocus: (conversationId: string) => void
  className?: string
}) {
  const topic = conversation.topicSummary || "Untitled conversation"
  return (
    <button
      type="button"
      onClick={() => onToggleFocus(conversation.id)}
      aria-pressed={isFocused}
      title={topic}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
        "transition-colors hover:brightness-110",
        className
      )}
      style={{
        borderColor: conversationColor(colorIndex, isFocused ? 0.7 : 0.35),
        backgroundColor: conversationColor(colorIndex, isFocused ? 0.16 : 0.07),
        color: conversationColor(colorIndex),
      }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: conversationColor(colorIndex) }}
      />
      <span className="truncate">{topic}</span>
      <span className="shrink-0 tabular-nums opacity-60">{conversation.messageIds.length}</span>
    </button>
  )
}

/**
 * Floating legend pill listing the stream's conversations in palette order.
 * Absolutely positioned (INV-21: no layout shift when toggling), mirroring
 * the "Loading older messages" float. Chips toggle focus; X closes the
 * overlay (drops the URL param).
 */
export function ConversationLegend({
  overlay,
  isSearchOpen,
  onClose,
}: {
  overlay: ConversationOverlayContext
  isSearchOpen: boolean
  onClose: () => void
}) {
  const { model, focusedConversationId, onToggleFocus } = overlay
  return (
    <div
      data-testid="conversation-legend"
      className={cn(
        "absolute left-1/2 z-20 w-max max-w-[min(92%,44rem)] -translate-x-1/2",
        isSearchOpen ? "top-14" : "top-2"
      )}
    >
      <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/95 py-1 pl-3 pr-1 shadow-md backdrop-blur-sm">
        <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex items-center gap-1 overflow-x-auto px-1 scrollbar-thin">
          {model.conversations.length === 0 ? (
            <span className="whitespace-nowrap px-1 text-xs text-muted-foreground">No conversations detected yet</span>
          ) : (
            model.conversations.map((conversation) => (
              <ConversationChip
                key={conversation.id}
                conversation={conversation}
                colorIndex={model.colorIndexById.get(conversation.id) ?? 0}
                isFocused={focusedConversationId === conversation.id}
                onToggleFocus={onToggleFocus}
                className={cn(
                  "max-w-[11rem] shrink-0",
                  focusedConversationId != null && focusedConversationId !== conversation.id && "opacity-50"
                )}
              />
            ))
          )}
        </div>
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
    </div>
  )
}

/** Hue strip + wash painted over a message row. Pointer-transparent. */
function RowTint({ colorIndex }: { colorIndex: number | null }) {
  if (colorIndex == null) {
    // Unassigned: dotted muted strip, no wash — reads as "extraction hasn't
    // placed this yet" without raising an alarm for just-sent messages.
    return (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
        style={{
          background:
            "repeating-linear-gradient(to bottom, hsl(var(--muted-foreground) / 0.35) 0 4px, transparent 4px 9px)",
        }}
      />
    )
  }
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
 * - hue rail + soft wash for the row's primary conversation (dotted muted
 *   rail when unassigned)
 * - topic chip above the first message of each contiguous block
 * - dimming when another conversation is focused via chip/legend
 * - a hover swatch on the rail that opens the correction menu ("this belongs
 *   to …"), feeding boundary-extraction feedback
 *
 * All decoration is absolutely positioned or stacked above/below the row —
 * the message itself never moves when the overlay toggles (INV-21).
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
  const { model, focusedConversationId, onToggleFocus, onReassignMessage, pendingMessageId } = overlay
  const conversation = annotation.conversationId ? model.conversationsById.get(annotation.conversationId) : undefined
  const colorIndex = conversation ? (model.colorIndexById.get(conversation.id) ?? 0) : null
  const isDimmed = focusedConversationId != null && annotation.conversationId !== focusedConversationId
  const isPending = pendingMessageId === messageId

  return (
    <div className={cn("transition-opacity duration-200", isDimmed && "opacity-40 saturate-50")}>
      {annotation.blockStart && conversation && colorIndex != null && (
        <div data-testid="conversation-block-chip" className="flex px-3 pt-3 sm:px-6">
          {/* ml-11 = avatar column (32px) + gap (12px): chips align with message text */}
          <ConversationChip
            conversation={conversation}
            colorIndex={colorIndex}
            isFocused={focusedConversationId === conversation.id}
            onToggleFocus={onToggleFocus}
            className="ml-11 max-w-[70%]"
          />
        </div>
      )}
      <div data-testid="conversation-overlay-row" className="group/convrow relative">
        {children}
        <RowTint colorIndex={colorIndex} />
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
