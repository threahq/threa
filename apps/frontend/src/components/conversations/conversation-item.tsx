import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { RelativeTime } from "@/components/relative-time"
import { useConversationService } from "@/contexts"
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
  const { topicSummary, messageIds, status, lastActivityAt, effectiveCompleteness, temporalStaleness } = conversation

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <div
        className={cn("rounded-lg border bg-card transition-colors", temporalStaleness >= 3 && "opacity-60", className)}
      >
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full text-left p-3 hover:bg-accent/50 transition-colors rounded-lg">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 flex-1 min-w-0">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{topicSummary || "Untitled conversation"}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-muted-foreground">{messageIds.length} messages</span>
                    <StatusBadge status={status} />
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <CompletenessIndicator score={effectiveCompleteness} />
                <RelativeTime date={lastActivityAt} className="text-xs text-muted-foreground" />
              </div>
            </div>
          </button>
        </CollapsibleTrigger>
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

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge variant="outline" className="text-xs py-0 px-1.5 h-5 bg-green-500/10 text-green-600 border-green-500/20">
          Active
        </Badge>
      )
    case "stalled":
      return (
        <Badge
          variant="outline"
          className="text-xs py-0 px-1.5 h-5 bg-yellow-500/10 text-yellow-600 border-yellow-500/20"
        >
          Stalled
        </Badge>
      )
    case "resolved":
      return (
        <Badge variant="outline" className="text-xs py-0 px-1.5 h-5 bg-blue-500/10 text-blue-600 border-blue-500/20">
          Resolved
        </Badge>
      )
    default:
      return null
  }
}

function CompletenessIndicator({ score }: { score: number }) {
  const clampedScore = Math.max(1, Math.min(7, score))
  const segments = 7

  const getDescription = (s: number): string => {
    if (s <= 2) return "Just started - conversation has recently begun"
    if (s <= 4) return "In progress - ongoing discussion"
    if (s <= 6) return "Mostly complete - wrapping up"
    return "Complete - conversation appears resolved"
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex gap-0.5 cursor-help">
            {Array.from({ length: segments }).map((_, i) => (
              <div key={i} className={cn("w-1.5 h-3 rounded-sm", i < clampedScore ? "bg-primary" : "bg-muted")} />
            ))}
          </div>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p className="font-medium">Completeness: {clampedScore}/7</p>
          <p className="text-xs text-muted-foreground">{getDescription(clampedScore)}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
