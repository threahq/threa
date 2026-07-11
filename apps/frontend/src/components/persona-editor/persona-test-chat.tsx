import { useState } from "react"
import { MessageSquare } from "lucide-react"
import { toast } from "sonner"
import { useQueryClient } from "@tanstack/react-query"
import type { PersonaConfigResponse } from "@threa/types"
import { Button } from "@/components/ui/button"
import { SidePanel, SidePanelContent, SidePanelHeader, SidePanelTitle } from "@/components/ui/side-panel"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { StreamContent } from "@/components/timeline"
import { useArchiveStream } from "@/hooks"
import { personaKeys, useCreateTestStream } from "@/hooks/use-personas"
import { syncHintText, type SyncState } from "./persona-form"

interface PersonaTestChatProps {
  workspaceId: string
  personaId: string
  /** The draft's bound test stream (`config.draft?.testStreamId`), or null. */
  testStreamId: string | null
  /** Mirrored draft-sync state from the editor form (deliverable 5 indicator). */
  syncState: SyncState
}

/**
 * The persona test-chat lifecycle, shared by the desktop pane and the mobile
 * drawer so both drive one ephemeral scratchpad the same way (D5/D6). "Start"
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
    if (!createTestStream.isPending) createTestStream.mutate()
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

/** Empty-state prompt shared by both surfaces: explains the test chat and starts it. */
function PersonaTestChatEmptyState({ onStart, isStarting }: { onStart: () => void; isStarting: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <MessageSquare className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="max-w-xs text-sm text-muted-foreground">
        Talk to the candidate persona before you commit. Turns run against your draft config, and nothing here is saved
        to memory.
      </p>
      <Button type="button" size="sm" onClick={onStart} disabled={isStarting}>
        {isStarting ? "Starting…" : "Start test chat"}
      </Button>
    </div>
  )
}

/**
 * Desktop right-pane test chat (D5). Mounts {@link StreamContent} directly —
 * never through `usePanel()`, which is a single global `?panel=` slot.
 */
export function PersonaTestChatPane({ workspaceId, personaId, testStreamId, syncState }: PersonaTestChatProps) {
  const { start, end, isStarting, isEnding } = usePersonaTestSession(workspaceId, personaId, testStreamId)

  if (!testStreamId) {
    return (
      <SidePanel>
        <SidePanelHeader>
          <SidePanelTitle>Test chat</SidePanelTitle>
        </SidePanelHeader>
        <SidePanelContent>
          <PersonaTestChatEmptyState onStart={start} isStarting={isStarting} />
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
        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={end} disabled={isEnding}>
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
 * Mobile test affordance (D5 revision): a "Test draft" button opens a bottom
 * drawer over the editor mounting the SAME test-chat content — no route change,
 * so the editor form never unmounts and its draft state survives close. The
 * drawer is a tall dvh sheet so {@link StreamContent}'s own mobile keyboard
 * choreography (owned-scroller pin) keeps the composer above the keyboard; the
 * app `Drawer` already runs `repositionInputs={false}` for exactly this reason.
 * Opening the drawer starts the session when none is active (one tap, matching
 * the old navigate-on-click intent); an already-active session just reopens.
 */
export function PersonaTestChatDrawer({ workspaceId, personaId, testStreamId, syncState }: PersonaTestChatProps) {
  const [open, setOpen] = useState(false)
  const { start, end, isStarting, isEnding } = usePersonaTestSession(workspaceId, personaId, testStreamId)

  const handleOpen = () => {
    setOpen(true)
    if (!testStreamId) start()
  }

  const syncHint = syncHintText(syncState)

  return (
    <>
      <Button type="button" variant="outline" className="w-full" onClick={handleOpen} disabled={isStarting}>
        {isStarting ? "Starting…" : "Test draft"}
      </Button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="mt-0 h-[92dvh]">
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
              <div className="min-w-0">
                <DrawerTitle className="text-base font-semibold">Test chat</DrawerTitle>
                <p className="truncate text-[11px] text-muted-foreground" aria-live="polite">
                  {testStreamId
                    ? `Chatting with the draft config${syncHint ? ` · ${syncHint}` : ""}`
                    : "Runs against your draft — nothing is saved to memory."}
                </p>
              </div>
              {testStreamId && (
                <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={end} disabled={isEnding}>
                  End test chat
                </Button>
              )}
            </header>
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {testStreamId ? (
                <StreamContent workspaceId={workspaceId} streamId={testStreamId} autoFocus />
              ) : (
                <PersonaTestChatEmptyState onStart={start} isStarting={isStarting} />
              )}
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}
