import { LayoutGrid } from "lucide-react"
import { useParams } from "react-router-dom"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeaderTabs } from "@/components/layout"
import { useWorkspaceConversations } from "@/hooks/use-conversations"
import { BoardCard } from "@/components/board/board-card"

/**
 * The board: a cross-stream wall of conversations (Threa's topic primitive)
 * ordered by recent activity — the read-only foundation of the board view
 * (slice 1). Lenses and a scope filter land as tabs here later; for now a single
 * "All" tab shows everything the viewer can read.
 */
export function BoardPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  if (!workspaceId) return null
  return <BoardPageInner workspaceId={workspaceId} />
}

function BoardPageInner({ workspaceId }: { workspaceId: string }) {
  const { data: conversations, isLoading } = useWorkspaceConversations(workspaceId, { limit: 100 })

  let content
  if (isLoading) {
    content = (
      <div className="flex flex-col gap-2 px-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    )
  } else if (!conversations?.length) {
    content = (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <LayoutGrid className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">Nothing on the board yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          As your conversations build up, the topics worth returning to surface here, newest activity first.
        </p>
      </div>
    )
  } else {
    content = (
      <div className="flex flex-col gap-2 px-3">
        {conversations.map((conversation) => (
          <BoardCard key={conversation.id} workspaceId={workspaceId} conversation={conversation} />
        ))}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeaderTabs
        backTo={`/w/${workspaceId}`}
        icon={LayoutGrid}
        title="Board"
        value="all"
        tabs={[{ value: "all", label: "All", href: `/w/${workspaceId}/board` }]}
      />
      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <main className="py-2">{content}</main>
      </ScrollArea>
    </div>
  )
}
