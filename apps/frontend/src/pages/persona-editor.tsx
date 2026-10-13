import { useMemo, useState, type ReactNode } from "react"
import { Link, Navigate, useParams } from "react-router-dom"
import { ArrowLeft, MessageSquare } from "lucide-react"
import { WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { SidebarToggle } from "@/components/layout"
import { PhonePaneSwitcher, usePhoneHeaderSwipe } from "@/components/panes"
import { PagePanes } from "@/components/panes/page-panes"
import { usePaneToggle } from "@/components/stream-context"
import { createPersonaTestPanelId, usePanel } from "@/contexts"
import { panelIdsOf } from "@/lib/panel-tabs"
import { hasPermission } from "@/lib/permissions"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspacePersonas } from "@/stores/workspace-store"
import { usePersonaConfig } from "@/hooks/use-personas"
import { PersonaEditorForm } from "@/components/persona-editor/persona-editor-form"
import { CustomPersonaEditor } from "@/components/persona-editor/custom-persona-editor"
import { PersonaSyncContext } from "@/components/persona-editor/persona-test-chat"
import type { SyncState } from "@/components/persona-editor/persona-form"
import { ApiError } from "@/api/client"

/**
 * Full-page persona editor (roadmap 7.1/7.2, user-scoped-personas). Reached from
 * the workspace-settings Personas tab (built-ins + workspace customs, admin) or
 * the personal-settings "My personas" section (a member's own personal personas).
 * Access is admin OR persona owner. The editor is the route's own pane; "Test
 * draft" opens the draft's test chat as a `test:` pane beside it.
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
  // Mirrored from the form so the test pane can show the same "saving/saved" indicator;
  // the debounce itself stays owned by the form (deliverable 5).
  const [syncState, setSyncState] = useState<SyncState>("idle")
  // The test pane only has a draft to test once there is an editable persona.
  const testable = !!config && !notFound
  const testStreamId = config?.draft?.testStreamId ?? null
  const draft = useMemo(() => (testable ? { testStreamId, syncState } : null), [testable, testStreamId, syncState])

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

  const editor = (
    <div className="flex h-full flex-col">
      <PersonaEditorHeader
        workspaceId={workspaceId}
        personaId={personaId}
        title={config ? `Edit ${config.resolved.name}` : "Edit persona"}
        backTo={backTo}
        backLabel={isPersonalPersona ? "Back to AI settings" : "Back to AI Agents"}
        testable={testable}
      />
      <main data-pane-landing tabIndex={-1} className="min-w-0 flex-1 overflow-auto outline-none">
        <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">{body}</div>
      </main>
    </div>
  )

  return (
    <PersonaSyncContext.Provider value={draft}>
      <PagePanes workspaceId={workspaceId} page={editor} />
    </PersonaSyncContext.Provider>
  )
}

interface PersonaEditorHeaderProps {
  workspaceId: string
  personaId: string
  title: string
  backTo: string
  backLabel: string
  testable: boolean
}

/** The editor's pane header: always first of a phone's panes, so it keeps the sidebar toggle. */
function PersonaEditorHeader({ workspaceId, personaId, title, backTo, backLabel, testable }: PersonaEditorHeaderProps) {
  const { layout } = usePanel()
  const testId = createPersonaTestPanelId(personaId)
  const [testOnShow, toggleTest] = usePaneToggle(panelIdsOf(layout).includes(testId) ? testId : null, testId)
  return (
    <header className="relative flex h-12 shrink-0 items-center gap-2 border-b px-4" {...usePhoneHeaderSwipe()}>
      <SidebarToggle location="page" />
      <Button asChild variant="ghost" size="icon" className="h-8 w-8">
        <Link to={backTo} aria-label={backLabel}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
      </Button>
      <h1 className="min-w-0 flex-1 truncate font-semibold">{title}</h1>
      {testable && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-pressed={testOnShow}
          onClick={toggleTest}
        >
          <MessageSquare className="h-4 w-4" />
          Test draft
        </Button>
      )}
      <PhonePaneSwitcher workspaceId={workspaceId} />
    </header>
  )
}
