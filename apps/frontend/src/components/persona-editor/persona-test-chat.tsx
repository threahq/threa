import { createContext, useContext } from "react"
import { MessageSquare } from "lucide-react"
import { toast } from "sonner"
import { useQueryClient } from "@tanstack/react-query"
import type { PersonaConfigResponse } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { SidePanel, SidePanelContent, SidePanelTitle } from "@/components/ui/side-panel"
import { PaneHeader } from "@/components/panes"
import { StreamContent } from "@/components/timeline"
import { useRevealReady } from "@/contexts"
import { useArchiveStream } from "@/hooks"
import { personaKeys, useCreateTestStream } from "@/hooks/use-personas"
import { syncHintText, type SyncState } from "./persona-form"

/**
 * The persona test-chat lifecycle: one ephemeral scratchpad per draft. "Start"
 * create-or-returns the bound test stream (the cache write flips `testStreamId`
 * on, which mounts the chat); "End" archives the scratchpad but KEEPS the draft
 * patch (unlike Discard/Save, which drop it). Durability is server-owned —
 * `getConfig` reads an archived bound stream as no test stream — so dropping the
 * cached pointer here is only an optimistic hop to the empty state.
 */
function usePersonaTestSession(workspaceId: string, personaId: string, testStreamId: string | null) {
  const queryClient = useQueryClient()
  const createTestStream = useCreateTestStream(workspaceId, personaId)
  const archiveStream = useArchiveStream(workspaceId)

  const start = () => {
    if (createTestStream.isPending) return
    createTestStream.mutate(undefined, {
      onError: () => toast.error("Failed to start the test chat"),
    })
  }

  const end = () => {
    if (!testStreamId || archiveStream.isPending) return
    archiveStream.mutate(testStreamId, {
      onSuccess: () => {
        // Drop only the pointer, never the patch: back to the empty state with
        // edits intact. Only on success — a failed archive keeps the still-active
        // stream mounted to retry.
        queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
          old?.draft ? { ...old, draft: { ...old.draft, testStreamId: null } } : old
        )
      },
      onError: () => toast.error("Failed to end the test chat"),
    })
  }

  return { start, end, isStarting: createTestStream.isPending, isEnding: archiveStream.isPending }
}

/** Empty-state prompt: explains the test chat and starts it. */
function PersonaTestChatEmptyState({ onStart, isStarting }: { onStart: () => void; isStarting: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <MessageSquare className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="max-w-xs text-sm text-muted-foreground">
        Talk to the candidate persona before you commit. Turns run against your draft config, and nothing here is saved
        to memory. Saving or discarding the draft ends the test chat.
      </p>
      <Button type="button" size="sm" onClick={onStart} disabled={isStarting}>
        {isStarting ? "Starting…" : "Start test chat"}
      </Button>
    </div>
  )
}

/** What the editor's test pane needs of its draft: its bound test stream and the form's sync state. Null when the persona isn't editable, undefined while its config loads. */
export const PersonaSyncContext = createContext<
  { testStreamId: string | null; syncState: SyncState } | null | undefined
>(null)

interface PersonaTestChatPaneProps {
  workspaceId: string
  personaId: string
  className?: string
}

/** The draft's test chat, as the `test:<personaId>` pane beside its editor. */
export function PersonaTestChatPane({ workspaceId, personaId, className }: PersonaTestChatPaneProps) {
  const draft = useContext(PersonaSyncContext)
  const testStreamId = draft?.testStreamId ?? null
  const { start, end, isStarting, isEnding } = usePersonaTestSession(workspaceId, personaId, testStreamId)
  const syncHint = draft ? syncHintText(draft.syncState) : null
  // A test stream's own StreamContent reports for it.
  useRevealReady(draft !== undefined && !testStreamId)

  return (
    <SidePanel className={className} data-editor-zone="panel" role="region" aria-label="Test chat">
      <PaneHeader workspaceId={workspaceId} name="Test chat" title={<SidePanelTitle>Test chat</SidePanelTitle>} />
      {testStreamId && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" aria-live="polite">
            Chatting with the draft config{syncHint ? ` · ${syncHint}` : ""}
          </p>
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0" onClick={end} disabled={isEnding}>
            End test chat
          </Button>
        </div>
      )}
      <SidePanelContent className="relative">
        {testStreamId ? (
          <StreamContent workspaceId={workspaceId} streamId={testStreamId} autoFocus />
        ) : (
          draft && <PersonaTestChatEmptyState onStart={start} isStarting={isStarting} />
        )}
      </SidePanelContent>
    </SidePanel>
  )
}
