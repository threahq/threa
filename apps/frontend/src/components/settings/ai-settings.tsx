import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ChevronDown, Pencil } from "lucide-react"
import { serializeToMarkdown, parsePromptMarkdown } from "@/components/editor/editor-markdown"
import { EditorActionBar, RichEditor, type RichEditorHandle } from "@/components/editor"
import { EncryptedScratchpadsSection } from "@/components/encryption"
import { Button, buttonVariants } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { PersonaListAvatar } from "@/components/persona-avatar"
import { PersonaForkDialog } from "@/components/workspace-settings/persona-fork-dialog"
import { PersonalSubagentModelsSection } from "./subagent-models-settings"
import { usePreferences } from "@/contexts"
import { useInputMode } from "@/hooks/use-input-mode"
import { useDefaultCompanionPersona } from "@/hooks/use-default-companion-persona"
import { useCompanionRoster } from "@/hooks/use-companion-roster"
import { useArchivedPersonas, useUnarchivePersona } from "@/hooks/use-personas"
import { useWorkspacePersonas } from "@/stores/workspace-store"
import {
  CompanionAgentSelect,
  companionPickerValue,
  companionPointerFromPickerValue,
} from "@/components/stream-settings/companion-agent-select"
import { type JSONContent } from "@threa/types"

const MODIFIER_LABEL =
  typeof navigator !== "undefined" && navigator.platform?.toLowerCase().includes("mac") ? "Cmd" : "Ctrl"

/**
 * The viewer's personal default companion for scratchpads with no explicit pick.
 * A leading "Workspace default (<name>)" option round-trips as null (inherit the
 * workspace tier); any persona pick stores that concrete id, which wins over the
 * workspace default. Mirrors `BoardHomeSection`'s sentinel-value technique.
 */
export function PersonalDefaultCompanionSection({ workspaceId }: { workspaceId: string }) {
  const { preferences, updatePreference, isLoading } = usePreferences()
  const personas = useCompanionRoster(workspaceId)
  const { workspaceDefault } = useDefaultCompanionPersona(workspaceId)

  // An override that no longer resolves (archived persona) degrades to the
  // synthetic "workspace default" rather than showing an empty trigger.
  const value = companionPickerValue(personas, preferences?.defaultCompanionPersonaId)

  const onChange = (next: string) => {
    void updatePreference("defaultCompanionPersonaId", companionPointerFromPickerValue(next))
  }

  if (personas.length === 0) return null

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Default companion</h3>
        <p className="text-sm text-muted-foreground">
          The agent that answers in your scratchpads unless a scratchpad has its own pick. Choose Workspace default to
          follow whatever your workspace sets.
        </p>
      </div>
      <CompanionAgentSelect
        workspaceId={workspaceId}
        personas={personas}
        value={value}
        onChange={onChange}
        defaultOption={{ label: `Workspace default (${workspaceDefault?.name ?? "Ariadne"})` }}
        disabled={isLoading}
        triggerClassName="w-full sm:w-72"
      />
    </section>
  )
}

/**
 * "My personas" — a member's own personal personas (user-scoped-personas), the
 * personal-settings counterpart to the admin `PersonasTab`. The active list reads
 * the bootstrap-backed store (the server scopes personal rows to their owner, so
 * `managedBy === "user"` here is kind placement, not a security filter); each row
 * links (INV-40) to the shared editor. "New persona" forks any caller-visible
 * persona (built-in, workspace custom, own personal) or a blank into a new
 * personal one. Archived personal personas sit behind a disclosure with Unarchive.
 */
export function MyPersonasSection({ workspaceId }: { workspaceId: string }) {
  const storePersonas = useWorkspacePersonas(workspaceId)
  const { data: archivedAll } = useArchivedPersonas(workspaceId)
  const unarchive = useUnarchivePersona(workspaceId)
  const [archivedOpen, setArchivedOpen] = useState(false)

  const personal = useMemo(
    () =>
      storePersonas
        .filter((p) => p.managedBy === "user" && p.status === "active")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [storePersonas]
  )

  // Fork sources: every persona the caller can currently see, mapped to the light
  // list-item shape the dialog renders (it only uses id/name); Blank is appended
  // by the dialog itself.
  const forkSources = useMemo(
    () => storePersonas.filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name })),
    [storePersonas]
  )

  // `GET /personas/archived` returns workspace customs too (for admins); the
  // personal roster only shows the caller's own personal archived personas.
  const archived = archivedAll?.filter((p) => p.kind === "personal")

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">My personas</h3>
          <p className="text-sm text-muted-foreground">
            Personal companions only you can see and use in your scratchpads. Fork a built-in or workspace agent, or
            start from a blank one.
          </p>
        </div>
        <PersonaForkDialog workspaceId={workspaceId} sources={forkSources} scope="personal" />
      </div>

      {personal.length > 0 ? (
        <ul className="space-y-2">
          {personal.map((persona) => (
            <li key={persona.id} className="flex items-center gap-3 rounded-lg border border-input bg-card p-3">
              <PersonaListAvatar workspaceId={workspaceId} persona={persona} size="lg" />
              <div className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{persona.name}</span>
                {persona.description && <p className="truncate text-xs text-muted-foreground">{persona.description}</p>}
              </div>
              <Link
                to={`/w/${workspaceId}/settings/personas/${persona.id}`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
              >
                <Pencil className="mr-1 h-3.5 w-3.5" />
                Edit
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">You haven&apos;t created any personal personas yet.</p>
      )}

      {archived && archived.length > 0 && (
        <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", archivedOpen && "rotate-180")} />
            Archived ({archived.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <ul className="space-y-2">
              {archived.map((persona) => (
                <li
                  key={persona.id}
                  className="flex items-center gap-3 rounded-lg border border-dashed border-input p-3"
                >
                  <PersonaListAvatar workspaceId={workspaceId} persona={persona} size="lg" />
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{persona.name}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={unarchive.isPending}
                    onClick={() =>
                      unarchive.mutate(persona.id, { onError: () => toast.error("Failed to unarchive persona") })
                    }
                  >
                    Unarchive
                  </Button>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  )
}

export function AISettings() {
  const { preferences, updatePreference, isLoading } = usePreferences()
  const { workspaceId } = useParams<{ workspaceId: string }>()
  // Selection toolbar is a hover/mouse affordance — suppress it only when a
  // finger is the active input, so a mouse on a touchscreen laptop keeps it.
  const disableSelectionToolbar = useInputMode() === "touch"
  const editorRef = useRef<RichEditorHandle>(null)
  const savedPrompt = preferences?.scratchpadCustomPrompt ?? ""
  const normalizedSavedPrompt = savedPrompt.trim()
  const [contentJson, setContentJson] = useState<JSONContent>(() => parsePromptMarkdown(savedPrompt))
  const [formatOpen, setFormatOpen] = useState(false)

  useEffect(() => {
    setContentJson(parsePromptMarkdown(savedPrompt))
    setFormatOpen(false)
  }, [savedPrompt])

  const currentMarkdown = useMemo(() => serializeToMarkdown(contentJson).trim(), [contentJson])
  const isDirty = currentMarkdown !== normalizedSavedPrompt

  const handleSave = async () => {
    if (!isDirty || isLoading) {
      return
    }

    await updatePreference("scratchpadCustomPrompt", currentMarkdown.length > 0 ? currentMarkdown : null)
  }

  const handleReset = () => {
    setContentJson(parsePromptMarkdown(savedPrompt))
    setFormatOpen(false)
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Scratchpad Instructions</h3>
          <p className="text-sm text-muted-foreground">
            Add standing guidance that Ariadne should follow in your personal scratchpads. This is injected after the
            base system prompt for scratchpads and scratchpad-root threads only.
          </p>
        </div>

        <div className="input-glow-wrapper">
          <div
            className="rounded-lg border border-input bg-card p-3"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']")) {
                return
              }
              editorRef.current?.focus()
            }}
          >
            <RichEditor
              ref={editorRef}
              value={contentJson}
              onChange={setContentJson}
              onSubmit={handleSave}
              placeholder="Tell Ariadne how to think and help in your scratchpads..."
              messageSendMode="cmdEnter"
              staticToolbarOpen={formatOpen}
              disableSelectionToolbar={disableSelectionToolbar}
              ariaLabel="Scratchpad custom prompt editor"
              className="min-h-0 [&_.tiptap]:min-h-[180px] [&_.tiptap]:max-h-[320px]"
              enableMentions={false}
              enableChannels={false}
              enableCommands={false}
              enableEmoji={false}
            />

            <div className="mt-2 border-t pt-2" onMouseDown={(event) => event.preventDefault()}>
              <EditorActionBar
                editorHandle={editorRef.current}
                disabled={isLoading}
                formatOpen={formatOpen}
                onFormatOpenChange={setFormatOpen}
                showAttach={false}
                showMention={false}
                showEmoji={false}
                trailingContent={
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleReset}
                      disabled={!isDirty || isLoading}
                    >
                      Reset
                    </Button>
                    <Button type="button" size="sm" onClick={handleSave} disabled={!isDirty || isLoading}>
                      Save
                    </Button>
                  </div>
                }
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Delete everything and save to remove the custom prompt.</span>
          <span>{MODIFIER_LABEL}+Enter to save</span>
        </div>
      </section>

      {workspaceId && (
        <>
          <Separator />
          <PersonalDefaultCompanionSection workspaceId={workspaceId} />
          <PersonalSubagentModelsSection workspaceId={workspaceId} />
          <Separator />
          <MyPersonasSection workspaceId={workspaceId} />
        </>
      )}

      <Separator />

      <EncryptedScratchpadsSection />
    </div>
  )
}
