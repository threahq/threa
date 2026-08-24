import { StreamContent } from "@/components/timeline"
import { AgentBlockProvider, type AgentBlockData } from "@/components/timeline/agent-block-context"
import { StreamErrorBoundary } from "@/components/stream-error-boundary"
import type { Stream } from "@threa/types"

interface AsideConversationProps {
  workspaceId: string
  asideId: string
  aside?: Stream
  autoFocus?: boolean
  onInsertAgentBlock: (data: AgentBlockData) => void
}

/**
 * The aside's chat: the companion timeline against the aside stream. It IS a
 * companion stream with Ariadne — the same `StreamContent` a scratchpad or a
 * thread panel mounts — so nothing here is special-cased beyond the empty
 * state, which has to say what a surface with no messages in it is for.
 */
export function AsideConversation({
  workspaceId,
  asideId,
  aside,
  autoFocus,
  onInsertAgentBlock,
}: AsideConversationProps) {
  return (
    <StreamErrorBoundary streamId={asideId}>
      <AgentBlockProvider onInsert={onInsertAgentBlock}>
        <StreamContent
          workspaceId={workspaceId}
          streamId={asideId}
          stream={aside}
          autoFocus={autoFocus}
          emptyState={
            <div className="max-w-[15rem] px-6 text-center">
              <p className="text-[13px] text-foreground/80">A private page beside this conversation.</p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                Think out loud with Ariadne, or start a draft — nothing here is sent until you send it.
              </p>
            </div>
          }
        />
      </AgentBlockProvider>
    </StreamErrorBoundary>
  )
}
