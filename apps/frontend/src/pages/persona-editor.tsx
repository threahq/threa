import { useState, type ReactNode } from "react"
import { Link, Navigate, useParams } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import { Button } from "@/components/ui/button"
import { SidebarToggle } from "@/components/layout"
import { ThreadPanelSlot } from "@/components/layout/thread-panel-slot"
import { hasPermission } from "@/lib/permissions"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { usePersonaConfig } from "@/hooks/use-personas"
import { usePanelLayout, useIsMobile } from "@/hooks"
import { PersonaEditorForm } from "@/components/persona-editor/persona-editor-form"
import { PersonaTestChatDrawer, PersonaTestChatPane } from "@/components/persona-editor/persona-test-chat"
import type { SyncState } from "@/components/persona-editor/persona-form"
import { ApiError } from "@/api/client"

/**
 * Full-page persona (built-in agent) editor (roadmap 7.1/7.2), reached from the
 * workspace-settings Personas tab. Admin-gated (INV-59 — persona id in the URL).
 * Desktop: editor form left, draft test chat in a resizable right pane. Mobile:
 * editor only, with a "Test draft" action that opens the test scratchpad as a
 * normal stream.
 */
export function PersonaEditorPage() {
  const { workspaceId, personaId } = useParams<{ workspaceId: string; personaId: string }>()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId ?? "")
  const isAdmin = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)

  const { data: config, isLoading, error } = usePersonaConfig(workspaceId ?? "", personaId ?? "", { enabled: isAdmin })

  const notFound = ApiError.isApiError(error) && error.code === "PERSONA_NOT_FOUND"
  const isMobile = useIsMobile()
  // Mirrored from the form so the pane can show the same "saving/saved" indicator;
  // the debounce itself stays owned by the form (deliverable 5).
  const [syncState, setSyncState] = useState<SyncState>("idle")
  // The test pane only exists once there is an editable persona to test against.
  const showTestPane = !isMobile && !!config && !notFound
  const {
    containerRef,
    panelWidth,
    maxWidth,
    minWidth,
    displayWidth,
    shouldAnimate,
    isResizing,
    showContent,
    handleResizeStart,
    handleResizeKeyDown,
    handleTransitionEnd,
  } = usePanelLayout(showTestPane)

  if (!workspaceId || !personaId) return null
  // Wait for the bootstrap to resolve before deciding; a confirmed non-admin is
  // bounced (the config routes are admin-only server-side too).
  if (bootstrap && !isAdmin) return <Navigate to={`/w/${workspaceId}`} replace />

  let body: ReactNode
  if (notFound) {
    body = <p className="text-sm text-muted-foreground">This persona can&apos;t be edited.</p>
  } else if (isLoading || !config) {
    body = <p className="text-sm text-muted-foreground">Loading persona…</p>
  } else {
    body = (
      <PersonaEditorForm
        workspaceId={workspaceId}
        personaId={personaId}
        config={config}
        onSyncStateChange={setSyncState}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center gap-2 border-b px-4">
        <SidebarToggle location="page" />
        <Link to={`/w/${workspaceId}?ws-settings=personas`}>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Back to personas">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="font-semibold">{config ? `Edit ${config.resolved.name}` : "Edit persona"}</h1>
      </header>

      <div ref={containerRef} className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
            {body}
            {isMobile && config && !notFound && (
              <div className="mt-6">
                <PersonaTestChatDrawer
                  workspaceId={workspaceId}
                  personaId={personaId}
                  testStreamId={config.draft?.testStreamId ?? null}
                  syncState={syncState}
                />
              </div>
            )}
          </div>
        </main>

        {showTestPane && (
          <ThreadPanelSlot
            displayWidth={displayWidth}
            panelWidth={panelWidth}
            shouldAnimate={shouldAnimate}
            showContent={showContent}
            isResizing={isResizing}
            maxWidth={maxWidth}
            minWidth={minWidth}
            onTransitionEnd={handleTransitionEnd}
            onResizeStart={handleResizeStart}
            onResizeKeyDown={handleResizeKeyDown}
          >
            <PersonaTestChatPane
              workspaceId={workspaceId}
              personaId={personaId}
              testStreamId={config.draft?.testStreamId ?? null}
              syncState={syncState}
            />
          </ThreadPanelSlot>
        )}
      </div>
    </div>
  )
}
