import { useId, useState, type ReactNode } from "react"
import type { ReferenceAudience } from "@threahq/types"
import { ActorAvatar } from "@/components/actor-avatar"
import { AUDIENCE_TONE } from "@/components/editor/reference-audience-tone"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger, useInsideDrawer } from "@/components/ui/drawer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useActors } from "@/hooks"
import { useStreamName } from "@/hooks/use-stream-name"
import type { AudienceQuestionCopy, SendTone } from "@/lib/reference-audience"
import { cn } from "@/lib/utils"

interface SendAskDetailProps {
  workspaceId: string
  tone: SendTone
  lead: ReferenceAudience
  copy: AudienceQuestionCopy
  compact: boolean
  onPrimary: () => void
  onAlternative?: () => void
  /** The question line; tapping it opens the detail. */
  children: ReactNode
}

/** Who the question is about and what they'd get, with the same two answers. Popover on desktop, sheet on phones. */
export function SendAskDetail({
  workspaceId,
  tone,
  lead,
  copy,
  compact,
  onPrimary,
  onAlternative,
  children,
}: SendAskDetailProps) {
  const [open, setOpen] = useState(false)
  const nested = useInsideDrawer()
  const titleId = useId()
  const answer = (action: () => void) => () => {
    setOpen(false)
    action()
  }

  const trigger = (
    <button
      type="button"
      aria-haspopup="dialog"
      data-testid="send-ask-detail-trigger"
      className="flex h-[30px] min-w-0 items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  )
  // Radix sees Escape on the document before React does; stopping it there keeps the
  // composer's Escape (drop the question) for the next press.
  const closeOnlyDetail = (event: KeyboardEvent) => event.stopPropagation()
  const body = (
    <DetailBody
      titleId={titleId}
      workspaceId={workspaceId}
      tone={tone}
      lead={lead}
      copy={copy}
      compact={compact}
      onPrimary={answer(onPrimary)}
      onAlternative={onAlternative && answer(onAlternative)}
    />
  )

  if (compact) {
    return (
      <Drawer open={open} onOpenChange={setOpen} shouldScaleBackground={false} nested={nested}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="pb-[env(safe-area-inset-bottom)]" onEscapeKeyDown={closeOnlyDetail}>
          {body}
        </DrawerContent>
      </Drawer>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-[340px] max-w-[calc(100vw-1rem)] p-0"
        aria-labelledby={titleId}
        onEscapeKeyDown={closeOnlyDetail}
      >
        {body}
      </PopoverContent>
    </Popover>
  )
}

function DetailBody({
  titleId,
  workspaceId,
  tone,
  lead,
  copy,
  compact,
  onPrimary,
  onAlternative,
}: Omit<SendAskDetailProps, "children"> & { titleId: string }) {
  const { getUser } = useActors(workspaceId)
  const source = useStreamName(workspaceId, lead.streamId, "activity") ?? "the conversation"
  const people = lead.sampleUserIds.flatMap((id) => {
    const name = getUser(id)?.name
    return name ? [{ id, name }] : []
  })
  const more = lead.count - people.length
  const Icon = AUDIENCE_TONE[tone].icon
  const alternative = onAlternative ? copy.alternative : null

  const unreachableExplanation = alternative
    ? `Share the message instead and they read it here, without access to the rest of ${source}.`
    : `They don't have access to ${source}.`
  const explanation =
    tone === "reveal" ? `They see the shared message, nothing else from ${source}.` : unreachableExplanation

  const Title = compact ? DrawerTitle : "h4"
  // DrawerTitle labels the sheet with its own id; even `id={undefined}` would override it.
  const titleProps = compact ? {} : { id: titleId }
  return (
    <div data-testid="send-ask-detail" className={cn("flex flex-col gap-3", compact ? "p-4 pt-3" : "p-3")}>
      <Title
        {...titleProps}
        className={cn("flex items-start gap-2 text-sm font-semibold leading-5", AUDIENCE_TONE[tone].text)}
      >
        <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        {copy.full}
      </Title>
      {(people.length > 0 || more > 0) && (
        <ul className="flex flex-col gap-1.5">
          {people.map(({ id, name }) => (
            <li key={id} className="flex min-w-0 items-center gap-2 text-sm">
              <ActorAvatar actorId={id} actorType="user" workspaceId={workspaceId} size="xs" showStatus={false} />
              <span className="truncate">{name}</span>
            </li>
          ))}
          {more > 0 && <li className="pl-7 text-sm text-muted-foreground">+{more} more</li>}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">{explanation}</p>
      <div className={cn("flex gap-2", compact ? "flex-col-reverse" : "justify-end")}>
        {alternative && (
          <Button type="button" variant="outline" size={compact ? "default" : "sm"} onClick={onAlternative}>
            {alternative.full}
          </Button>
        )}
        <Button type="button" size={compact ? "default" : "sm"} onClick={onPrimary} autoFocus={!compact}>
          {copy.primary.full}
        </Button>
      </div>
    </div>
  )
}
