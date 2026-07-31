import { useSearchParams } from "react-router-dom"
import { cn } from "@/lib/utils"
import { useConversations } from "@/hooks"
import { ConversationItem } from "./conversation-item"
import { Skeleton } from "@/components/ui/skeleton"

interface ConversationListProps {
  workspaceId: string
  streamId: string
  className?: string
  onMessageClick?: () => void
}

export function ConversationList({ workspaceId, streamId, className, onMessageClick }: ConversationListProps) {
  const { conversations, isLoading, error } = useConversations(workspaceId, streamId)
  const [searchParams, setSearchParams] = useSearchParams()

  const expandedConversationId = searchParams.get("conv")

  const handleToggle = (conversationId: string) => {
    setSearchParams((prev) => {
      const newParams = new URLSearchParams(prev)
      if (expandedConversationId === conversationId) {
        newParams.delete("conv")
      } else {
        newParams.set("conv", conversationId)
      }
      return newParams
    })
  }

  if (error) {
    return <div className={cn("p-4 text-sm text-destructive", className)}>Failed to load conversations</div>
  }

  if (isLoading) {
    return (
      <div className={cn("space-y-2 p-2", className)}>
        <ConversationSkeleton />
        <ConversationSkeleton />
        <ConversationSkeleton />
      </div>
    )
  }

  if (conversations.length === 0) {
    return <div className={cn("p-4 text-sm text-muted-foreground text-center", className)}>No conversations yet</div>
  }

  const ordered = [...conversations].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
  )

  return (
    <div className={cn("space-y-1 p-2", className)}>
      {ordered.map((conversation) => (
        <ConversationItem
          key={conversation.id}
          workspaceId={workspaceId}
          conversation={conversation}
          isExpanded={expandedConversationId === conversation.id}
          onToggle={() => handleToggle(conversation.id)}
          onMessageClick={onMessageClick}
        />
      ))}
    </div>
  )
}

function ConversationSkeleton() {
  return (
    <div className="p-3 rounded-lg border bg-card">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <div className="flex flex-col items-end gap-1">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
    </div>
  )
}
