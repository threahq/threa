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
import { CollapsibleBody } from "@/lib/markdown/collapsible-body"
import { MarkdownBlockProvider } from "@/lib/markdown/markdown-block-context"

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
 * folds the whole block behind a Show more/less toggle past a line threshold,
 * via the shared {@link CollapsibleBody}. Mounted inside a MarkdownBlockProvider
 * keyed by the event id so any embedded code/quote blocks fold too.
 */
function DescriptionBody({ markdown }: { markdown: string }) {
  return (
    <CollapsibleBody kind="description" content={markdown} threshold={DEFAULT_DESCRIPTION_COLLAPSE_THRESHOLD}>
      <MarkdownContent content={markdown} className="text-sm leading-relaxed" />
    </CollapsibleBody>
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
