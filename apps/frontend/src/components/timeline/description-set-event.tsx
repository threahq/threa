import { useRef } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import {
  DEFAULT_DESCRIPTION_COLLAPSE_THRESHOLD,
  type AuthorType,
  type DescriptionSetEventPayload,
  type StreamEvent,
} from "@threa/types"
import { cn } from "@/lib/utils"
import { useActors } from "@/hooks"
import { useUserProfile } from "@/components/user-profile"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { triggerStyles, chipBase } from "@/lib/markdown/mention-renderer"
import { useBlockCollapse } from "@/lib/markdown/use-block-collapse"
import { useMeasuredLineCount } from "@/lib/markdown/use-measured-line-count"
import { InsideCollapsibleBlockProvider, MarkdownBlockProvider } from "@/lib/markdown/markdown-block-context"

interface DescriptionSetEventProps {
  event: StreamEvent
  workspaceId: string
}

// Map each actor kind to its mention chip color so the actor reads as a real
// mention. "system" (Threa) has no mention color of its own; the neutral
// channel style is the closest existing token.
const CHIP_STYLE_BY_ACTOR: Record<AuthorType, string> = {
  user: triggerStyles.user,
  persona: triggerStyles.persona,
  bot: triggerStyles.bot,
  system: triggerStyles.channel,
}

/**
 * The actor that set the description, rendered with mention semantics: the
 * user-mention color and, for users, the same click-to-open-profile affordance a
 * `@mention` has. Shows the display name (not an `@slug`) since it's an
 * attribution, not an inline mention.
 */
function DescriptionActor({
  actorName,
  actorId,
  actorType,
}: {
  actorName: string
  actorId: string | null
  actorType: AuthorType | null
}) {
  const { openUserProfile } = useUserProfile()
  const style = CHIP_STYLE_BY_ACTOR[actorType ?? "user"] ?? triggerStyles.user

  if (actorType === "user" && actorId) {
    return (
      <button
        type="button"
        onClick={() => openUserProfile(actorId)}
        className={cn(chipBase, "cursor-pointer hover:underline", style)}
      >
        {actorName}
      </button>
    )
  }
  return <span className={cn(chipBase, style)}>{actorName}</span>
}

/**
 * Renders the description body with the normal message-markdown pipeline and
 * folds the whole block behind a Show more/less toggle past a line threshold —
 * the same measure-then-clamp mechanism code/quote blocks use (and persisted per
 * event via the shared block-collapse cache, so it survives the timeline
 * remounting rows under virtualization). Mounted inside a MarkdownBlockProvider
 * keyed by the event id so any embedded code/quote blocks fold too.
 */
function DescriptionBody({ markdown }: { markdown: string }) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const { lineCount, lineHeightPx } = useMeasuredLineCount(bodyRef, [markdown])
  const collapsible = lineCount !== null && lineCount > DEFAULT_DESCRIPTION_COLLAPSE_THRESHOLD + 0.5
  const { collapsed, canToggle, toggle } = useBlockCollapse({ kind: "description", content: markdown, collapsible })

  const collapsedMaxHeight =
    collapsed && lineHeightPx !== null ? (DEFAULT_DESCRIPTION_COLLAPSE_THRESHOLD + 0.5) * lineHeightPx : undefined
  const bodyExpandable = collapsed && canToggle

  return (
    <div className="relative">
      <InsideCollapsibleBlockProvider active={canToggle}>
        <div
          ref={bodyRef}
          className={cn(collapsed && "overflow-hidden", bodyExpandable && "cursor-pointer")}
          style={collapsedMaxHeight !== undefined ? { maxHeight: collapsedMaxHeight } : undefined}
          onClick={bodyExpandable ? toggle : undefined}
        >
          <MarkdownContent content={markdown} className="text-sm leading-relaxed" />
        </div>
      </InsideCollapsibleBlockProvider>
      {collapsed && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-transparent to-background"
        />
      )}
      {canToggle && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="mt-1 flex cursor-pointer items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          )}
          {collapsed ? "Show more" : "Show less"}
        </button>
      )}
    </div>
  )
}

/**
 * Timeline row for `description_set`: "<actor> set the description" followed by
 * the description rendered as a normal message body (collapsible when long), or
 * "<actor> cleared the description" when the body is empty.
 */
export function DescriptionSetEvent({ event, workspaceId }: DescriptionSetEventProps) {
  const { getActorName } = useActors(workspaceId)
  const actorName = getActorName(event.actorId, event.actorType)
  const markdown = (event.payload as DescriptionSetEventPayload | undefined)?.descriptionMarkdown ?? null

  const actor = <DescriptionActor actorName={actorName} actorId={event.actorId} actorType={event.actorType} />

  if (!markdown) {
    return (
      <div className="py-2 px-3 sm:px-6 text-center">
        <p className="text-sm text-muted-foreground">{actor} cleared the description</p>
      </div>
    )
  }

  return (
    <div className="py-2 px-3 sm:px-6">
      <p className="text-center text-sm text-muted-foreground">{actor} set the description</p>
      <div className="mx-auto mt-1.5 max-w-2xl border-l-2 border-border pl-3.5">
        <MarkdownBlockProvider messageId={event.id}>
          <DescriptionBody markdown={markdown} />
        </MarkdownBlockProvider>
      </div>
    </div>
  )
}
