import { useNavigate } from "react-router-dom"
import { MessageSquare } from "lucide-react"
import { toast } from "sonner"
import { useQueryClient } from "@tanstack/react-query"
import type { PersonaConfigResponse } from "@threa/types"
import { Button } from "@/components/ui/button"
import { SidePanel, SidePanelContent, SidePanelHeader, SidePanelTitle } from "@/components/ui/side-panel"
import { StreamContent } from "@/components/timeline"
import { useArchiveStream } from "@/hooks"
import { personaKeys, useCreateTestStream } from "@/hooks/use-personas"
import { syncHintText, type SyncState } from "./persona-form"

interface PersonaTestChatPaneProps {
  workspaceId: string
  personaId: string
  /** The draft's bound test stream (`config.draft?.testStreamId`), or null. */
  testStreamId: string | null
  /** Mirrored draft-sync state from the editor form (deliverable 5 indicator). */
  syncState: SyncState
}

/**
 * Desktop right-pane test chat: an ephemeral scratchpad running companion turns
 * against the persona DRAFT (D5/D6). Mounts {@link StreamContent} directly — never
 * through `usePanel()`, which is a single global `?panel=` slot. "End test chat"
 * archives the scratchpad but KEEPS the draft patch (unlike Discard/Save, which
 * both drop it): v1 reuses the app's own archive mutation. Durability is
 * server-owned — `getConfig` reads an archived bound stream as no test stream — so
 * clearing the cached pointer here is only an optimistic drop to the empty state;
 * a reload resolves to the same empty state regardless.
 */
export function PersonaTestChatPane({ workspaceId, personaId, testStreamId, syncState }: PersonaTestChatPaneProps) {
  const queryClient = useQueryClient()
  const createTestStream = useCreateTestStream(workspaceId, personaId)
  const archiveStream = useArchiveStream(workspaceId)

  const handleStart = () => {
    if (createTestStream.isPending) return
    createTestStream.mutate()
  }

  const handleEnd = () => {
    if (!testStreamId || archiveStream.isPending) return
    archiveStream.mutate(testStreamId, {
      onSuccess: () => {
        // Drop only the pointer, never the patch: the pane returns to the empty
        // state but the edits stay so the user can keep tuning or Save. Only on
        // success — a failed archive keeps the still-active stream mounted to retry.
        queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
          old?.draft ? { ...old, draft: { ...old.draft, testStreamId: null } } : old
        )
      },
      onError: () => toast.error("Failed to end the test chat"),
    })
  }

  if (!testStreamId) {
    return (
      <SidePanel>
        <SidePanelHeader>
          <SidePanelTitle>Test chat</SidePanelTitle>
        </SidePanelHeader>
        <SidePanelContent className="flex flex-col items-center justify-center gap-3 p-6 text-center">
          <MessageSquare className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="max-w-xs text-sm text-muted-foreground">
            Talk to the candidate persona before you commit. Turns run against your draft config, and nothing here is
            saved to memory.
          </p>
          <Button type="button" size="sm" onClick={handleStart} disabled={createTestStream.isPending}>
            {createTestStream.isPending ? "Starting…" : "Start test chat"}
          </Button>
        </SidePanelContent>
      </SidePanel>
    )
  }

  const syncHint = syncHintText(syncState)

  return (
    <SidePanel>
      <SidePanelHeader>
        <div className="min-w-0">
          <SidePanelTitle>Test chat</SidePanelTitle>
          <p className="truncate text-[11px] text-muted-foreground" aria-live="polite">
            Chatting with the draft config{syncHint ? ` · ${syncHint}` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={handleEnd}
          disabled={archiveStream.isPending}
        >
          End test chat
        </Button>
      </SidePanelHeader>
      <SidePanelContent className="relative">
        <StreamContent workspaceId={workspaceId} streamId={testStreamId} autoFocus />
      </SidePanelContent>
    </SidePanel>
  )
}

/**
 * Mobile test affordance: no split view — ensure the test scratchpad exists, then
 * navigate to it as a normal stream (D5). Create-or-return is async so the target
 * id isn't known ahead of the click; a button that navigates on resolve is the
 * right shape here (a `Link` can't pre-address an id that doesn't exist yet).
 */
export function PersonaTestDraftButton({ workspaceId, personaId }: { workspaceId: string; personaId: string }) {
  const navigate = useNavigate()
  const createTestStream = useCreateTestStream(workspaceId, personaId)

  const handleTest = () => {
    if (createTestStream.isPending) return
    createTestStream.mutate(undefined, {
      onSuccess: ({ streamId }) => navigate(`/w/${workspaceId}/s/${streamId}`),
    })
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={handleTest}
      disabled={createTestStream.isPending}
    >
      {createTestStream.isPending ? "Starting…" : "Test draft"}
    </Button>
  )
}
