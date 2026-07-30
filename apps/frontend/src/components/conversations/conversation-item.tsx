import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ChevronDown, ChevronRight, PanelRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RelativeTime } from "@/components/relative-time"
import { useConversationService, usePanel, createConversationPanelId } from "@/contexts"
import { useActors } from "@/hooks"
import { conversationKeys } from "@/hooks/use-conversations"
import type { AuthorType, ConversationWithStaleness, Message } from "@threa/types"

interface ConversationItemProps {
  workspaceId: string
  conversation: ConversationWithStaleness
  isExpanded: boolean
  onToggle: () => void
  onMessageClick?: () => void
  className?: string
}

export function ConversationItem({
  workspaceId,
  conversation,
  isExpanded,
  onToggle,
  onMessageClick,
  className,
}: ConversationItemProps) {
  const { topicSummary, messageIds, lastActivityAt } = conversation
  const { openPanel } = usePanel()

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <div className={cn("rounded-lg border bg-card transition-colors", className)}>
        {/* Header row: the inline-expand trigger fills the row, the panel-open
            button sits beside it (outside the trigger so it isn't a nested button). */}
        <div className="flex items-stretch">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="min-w-0 flex-1 rounded-l-lg p-3 text-left transition-colors hover:bg-accent/50"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{topicSummary || "Untitled conversation"}</p>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {messageIds.length} {messageIds.length === 1 ? "message" : "messages"}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <RelativeTime date={lastActivityAt} className="text-xs text-muted-foreground" />
                </div>
              </div>
            </button>
          </CollapsibleTrigger>
          {/* Open the whole conversation in the side panel (Mechanism B) — peer to
              the inline expand, but coherent and reply-able. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="m-1 h-8 w-8 shrink-0 self-center text-muted-foreground hover:text-foreground"
                aria-label="Open conversation in panel"
                onClick={() => {
                  openPanel(createConversationPanelId(conversation.id))
                  // Close the conversation-list overlay (when this item is shown in
                  // one) so the panel it just opened isn't hidden behind it.
                  onMessageClick?.()
                }}
              >
                <PanelRight className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open in panel</TooltipContent>
          </Tooltip>
        </div>
        <CollapsibleContent>
          <div className="border-t px-3 py-2">
            <ConversationMessages
              workspaceId={workspaceId}
              conversationId={conversation.id}
              onMessageClick={onMessageClick}
            />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface ConversationMessagesProps {
  workspaceId: string
  conversationId: string
  onMessageClick?: () => void
}

function ConversationMessages({ workspaceId, conversationId, onMessageClick }: ConversationMessagesProps) {
  const conversationService = useConversationService()
  const { getActorName } = useActors(workspaceId)

  const {
    data: messages,
    isLoading,
    error,
  } = useQuery({
    queryKey: conversationKeys.messages(conversationId),
    queryFn: () => conversationService.getMessages(workspaceId, conversationId),
  })

  if (isLoading) {
    return (
      <div className="space-y-2 py-1">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  if (error) {
    return <p className="text-sm text-destructive py-1">Failed to load messages</p>
  }

  if (!messages || messages.length === 0) {
    return <p className="text-sm text-muted-foreground py-1">No messages</p>
  }

  return (
    <div className="space-y-2 py-1 max-h-64 overflow-y-auto">
      {messages.map((message) => (
        <MessagePreview
          key={message.id}
          message={message}
          workspaceId={workspaceId}
          getActorName={getActorName}
          onMessageClick={onMessageClick}
        />
      ))}
    </div>
  )
}

interface MessagePreviewProps {
  message: Message
  workspaceId: string
  getActorName: (actorId: string | null, actorType: AuthorType | null) => string
  onMessageClick?: () => void
}

function MessagePreview({ message, workspaceId, getActorName, onMessageClick }: MessagePreviewProps) {
  const maxLength = 200
  const truncatedContent =
    message.contentMarkdown.length > maxLength
      ? message.contentMarkdown.slice(0, maxLength) + "..."
      : message.contentMarkdown

  // Use message's own streamId - thread messages belong to thread streams, not the parent channel
  const messageUrl = `/w/${workspaceId}/s/${message.streamId}?m=${message.id}`
  const authorName = getActorName(message.authorId, message.authorType)

  return (
    <Link
      to={messageUrl}
      onClick={onMessageClick}
      className="block text-sm border-l-2 border-muted pl-2 py-1 hover:bg-accent/50 hover:border-primary rounded-r transition-colors"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-0.5">
        <span className="font-medium">{authorName}</span>
        <span>·</span>
        <RelativeTime date={message.createdAt} />
      </div>
      <p className="text-foreground/80 whitespace-pre-wrap break-words">{truncatedContent}</p>
    </Link>
  )
}
