import { useState, type ReactNode } from "react"
import { Link, Navigate, useParams } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import { Button } from "@/components/ui/button"
import { SidebarToggle } from "@/components/layout"
import { ThreadPanelSlot } from "@/components/layout/thread-panel-slot"
import { hasPermission } from "@/lib/permissions"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspacePersonas } from "@/stores/workspace-store"
import { usePersonaConfig } from "@/hooks/use-personas"
import { usePanelLayout, useIsSplitCapable } from "@/hooks"
import { PersonaEditorForm } from "@/components/persona-editor/persona-editor-form"
import { CustomPersonaEditor } from "@/components/persona-editor/custom-persona-editor"
import { PersonaTestChatDrawer, PersonaTestChatPane } from "@/components/persona-editor/persona-test-chat"
import type { SyncState } from "@/components/persona-editor/persona-form"
import { ApiError } from "@/api/client"

/**
 * Full-page persona editor (roadmap 7.1/7.2, user-scoped-personas). Reached from
 * the workspace-settings Personas tab (built-ins + workspace customs, admin) or
 * the personal-settings "My personas" section (a member's own personal personas).
 * Access is admin OR persona owner. Desktop: editor form left, draft test chat in
 * a resizable right pane. Mobile: editor only, with a "Test draft" action that
 * opens the test scratchpad as a normal stream.
 */
export function PersonaEditorPage() {
  const { workspaceId, personaId } = useParams<{ workspaceId: string; personaId: string }>()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId ?? "")
  const isAdmin = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  // A personal persona's store row reaches only its owner (server-scoped), so its
  // presence with `managedBy === "user"` proves ownership. A just-forked personal
  // persona is seeded into the store by the fork mutation, so this is already true
  // on the first render after navigating from "New persona".
  const personas = useWorkspacePersonas(workspaceId)
  const ownsPersonal = !!personaId && personas.some((p) => p.id === personaId && p.managedBy === "user")
  const allowed = isAdmin || ownsPersonal

  const {
    data: config,
    isLoading,
    error,
    refetch,
  } = usePersonaConfig(workspaceId ?? "", personaId ?? "", { enabled: allowed })

  const notFound = ApiError.isApiError(error) && error.code === "PERSONA_NOT_FOUND"
  // A personal persona returns to the owner's personal AI settings (openable by a
  // non-admin); a built-in/workspace persona returns to the admin roster.
  const isPersonalPersona = config?.kind === "personal" || ownsPersonal
  const backTo = isPersonalPersona ? `/w/${workspaceId}?settings=ai` : `/w/${workspaceId}?ws-settings=ai-agents`
  // The split needs ~MIN_MAIN_WIDTH + MIN_PANEL_WIDTH + sidebar of room; below
  // SPLIT_VIEW_BREAKPOINT (phone landscape, small tablets, narrow windows) the
  // drawer layout is strictly better than two crushed panes.
  const splitCapable = useIsSplitCapable()
  // Mirrored from the form so the pane can show the same "saving/saved" indicator;
  // the debounce itself stays owned by the form (deliverable 5).
  const [syncState, setSyncState] = useState<SyncState>("idle")
  // The test pane only exists once there is an editable persona to test against.
  const showTestPane = splitCapable && !!config && !notFound
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
  // Wait for the bootstrap to resolve before deciding; a viewer who is neither an
  // admin nor the persona's owner is bounced (the config routes reject them too).
  if (bootstrap && !allowed) return <Navigate to={`/w/${workspaceId}`} replace />

  let body: ReactNode
  if (notFound) {
    body = <p className="text-sm text-muted-foreground">This persona can&apos;t be edited.</p>
  } else if (error) {
    // Any non-404 failure (network, 500) must not read as an endless load.
    body = (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Couldn&apos;t load this persona&apos;s configuration.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    )
  } else if (isLoading || !config) {
    body = <p className="text-sm text-muted-foreground">Loading persona…</p>
  } else if (config.kind === "custom" || config.kind === "personal") {
    body = (
      <CustomPersonaEditor
        workspaceId={workspaceId}
        personaId={personaId}
        config={config}
        onSyncStateChange={setSyncState}
        returnTo={backTo}
      />
    )
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
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <Link to={backTo} aria-label={isPersonalPersona ? "Back to AI settings" : "Back to AI Agents"}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-semibold">
          {config ? `Edit ${config.resolved.name}` : "Edit persona"}
        </h1>
        {!splitCapable && config && !notFound && (
          <div className="shrink-0">
            <PersonaTestChatDrawer
              workspaceId={workspaceId}
              personaId={personaId}
              testStreamId={config.draft?.testStreamId ?? null}
              syncState={syncState}
            />
          </div>
        )}
      </header>

      <div ref={containerRef} className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">{body}</div>
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
