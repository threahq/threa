import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { useOptionalSettings, withStreamSettings } from "@/contexts/settings-context"
import { SettingsLink } from "@/components/workspace-settings/settings-link"
import { toast } from "sonner"
import { Pencil } from "lucide-react"
import { serializeToMarkdown, parsePromptMarkdown } from "@/components/editor/editor-markdown"
import { RichEditor, type RichEditorHandle } from "@/components/editor"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { PersonaListAvatar } from "@/components/persona-avatar"
import { PersonaForkDialog } from "@/components/workspace-settings/persona-fork-dialog"
import { PersonalSubagentModelsSection } from "./subagent-models-settings"
import {
  SETTING_CONTROL_CLASS,
  SETTING_CONTROL_HEIGHT,
  SettingEmptyNote,
  SettingRow,
  SettingsDisclosure,
  SettingsSection,
  settingIds,
  SaveError,
  SaveIndicator,
} from "./setting-primitives"
import { SETTING_INPUT_FRAME, SETTING_NOTE_TEXT } from "./setting-text"
import { settingDef } from "./settings-registry"
import { useCommittedText } from "./committed-field"
import { usePreferences } from "@/contexts"
import { useInputMode } from "@/hooks/use-input-mode"
import { useDefaultCompanionPersona } from "@/hooks/use-default-companion-persona"
import { useCompanionRoster } from "@/hooks/use-companion-roster"
import { useArchivedPersonas, useUnarchivePersona } from "@/hooks/use-personas"
import { useWorkspacePersonas } from "@/stores/workspace-store"
import {
  COMPANION_DEFAULT_TAGS,
  CompanionAgentSelect,
  companionPickerValue,
  companionPointerFromPickerValue,
} from "@/components/stream-settings/companion-agent-select"
import { StreamTypes, type JSONContent } from "@threahq/types"
import { useRouteStreamId, useStreamSettingsScope } from "./use-stream-settings-scope"

/**
 * The viewer's personal default agent for scratchpads with no explicit pick.
 * A leading row following the workspace default round-trips as null (inherit
 * the workspace tier); any persona pick stores that concrete id, which wins
 * over the workspace default.
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

  return (
    <SettingRow
      setting="default-companion"
      labelFor={false}
      description={
        <>
          {settingDef("default-companion").description}
          <ExistingScratchpadAgentLink workspaceId={workspaceId} />
        </>
      }
      control={
        <CompanionAgentSelect
          workspaceId={workspaceId}
          personas={personas}
          value={value}
          onChange={onChange}
          defaultOption={{ persona: workspaceDefault, tag: COMPANION_DEFAULT_TAGS.workspace }}
          disabled={isLoading}
          triggerClassName={SETTING_CONTROL_CLASS}
          aria-labelledby={settingIds("default-companion").label}
          aria-describedby={settingIds("default-companion").description}
        />
      }
    />
  )
}

/**
 * Where an existing scratchpad's agent changes: the scratchpad in view's Agent
 * page, else a pick of scratchpad. From another stream the window would read
 * a bare stream page as that stream's, so the pick opens over the workspace
 * home, a new history entry Back returns from.
 */
function ExistingScratchpadAgentLink({ workspaceId }: { workspaceId: string }) {
  const settings = useOptionalSettings()
  const routeStreamId = useRouteStreamId()
  const stream = useStreamSettingsScope(workspaceId, routeStreamId)
  if (!settings) return null
  if (stream?.type === StreamTypes.SCRATCHPAD) {
    return (
      <>
        {" "}
        <SettingsLink to={settings.getStreamSettingsUrl(stream.streamId, "companion", "stream-agent")}>
          Change this scratchpad&apos;s agent
        </SettingsLink>
      </>
    )
  }
  const pick = settings.getStreamSettingsUrl(null, "companion", "stream-agent")
  return (
    <>
      {" "}
      <SettingsLink
        to={
          routeStreamId === null
            ? pick
            : `/w/${workspaceId}?${withStreamSettings(new URLSearchParams(), null, "companion", "stream-agent")}`
        }
        leavesWindow={routeStreamId !== null}
      >
        Change a scratchpad&apos;s agent
      </SettingsLink>
    </>
  )
}

/**
 * The viewer's own personal personas, the personal counterpart to the admin
 * `PersonasTab`. The server scopes personal rows to their owner, so
 * `managedBy === "user"` here is kind placement, not a security filter. "New
 * agent" forks any agent the viewer can see, or a blank one.
 */
export function MyPersonasSection({ workspaceId }: { workspaceId: string }) {
  const storePersonas = useWorkspacePersonas(workspaceId)
  const { data: archivedAll } = useArchivedPersonas(workspaceId)
  const unarchive = useUnarchivePersona(workspaceId)

  const personal = useMemo(
    () =>
      storePersonas
        .filter((p) => p.managedBy === "user" && p.status === "active")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [storePersonas]
  )

  const forkSources = useMemo(
    () => storePersonas.filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name })),
    [storePersonas]
  )

  // `GET /personas/archived` returns workspace customs too (for admins); this
  // list only shows the caller's own archived personal personas.
  const archived = archivedAll?.filter((p) => p.kind === "personal")

  return (
    <>
      <SettingRow
        setting="my-personas"
        labelFor={false}
        control={<PersonaForkDialog workspaceId={workspaceId} sources={forkSources} scope="personal" />}
      >
        {personal.length > 0 ? (
          <ul aria-labelledby={settingIds("my-personas").label} className="-my-2 divide-y divide-border">
            {personal.map((persona) => (
              <li key={persona.id} className="flex min-h-11 items-center gap-3 py-2">
                <PersonaListAvatar workspaceId={workspaceId} persona={persona} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{persona.name}</p>
                  {persona.description && (
                    <p className={cn("truncate text-muted-foreground", SETTING_NOTE_TEXT)}>{persona.description}</p>
                  )}
                </div>
                <Link
                  to={`/w/${workspaceId}/settings/personas/${persona.id}`}
                  aria-label={`Edit ${persona.name}`}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0", SETTING_CONTROL_HEIGHT)}
                >
                  <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Edit
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <SettingEmptyNote>No agents yet.</SettingEmptyNote>
        )}
      </SettingRow>
      {archived && archived.length > 0 && (
        <SettingsDisclosure label="Archived agents" settings={[]} summary={`${archived.length} archived`}>
          <ul aria-label="Archived agents" className="divide-y divide-border">
            {archived.map((persona) => (
              <li key={persona.id} className="flex min-h-11 items-center gap-3 px-4 py-2">
                <PersonaListAvatar workspaceId={workspaceId} persona={persona} size="lg" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{persona.name}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn("shrink-0", SETTING_CONTROL_HEIGHT)}
                  aria-label={`Unarchive ${persona.name}`}
                  disabled={unarchive.isPending}
                  onClick={() =>
                    unarchive.mutate(persona.id, { onError: () => toast.error("Couldn't unarchive the agent") })
                  }
                >
                  Unarchive
                </Button>
              </li>
            ))}
          </ul>
        </SettingsDisclosure>
      )}
    </>
  )
}

/** Where your instructions stop applying, and where the per-stream equivalent lives. */
function InstructionsScope() {
  const streamId = useRouteStreamId()
  const settings = useOptionalSettings()
  return (
    <>
      {settingDef("ai-instructions").description}
      {streamId && settings && (
        <>
          {" "}
          <SettingsLink to={settings.getStreamSettingsUrl(streamId, "companion")}>
            Agent settings for this stream
          </SettingsLink>
        </>
      )}
    </>
  )
}

const INSTRUCTIONS_ERROR_ID = settingIds("ai-instructions").error

export function AISettings() {
  const { preferences, updatePreference } = usePreferences()
  const { workspaceId } = useParams<{ workspaceId: string }>()
  // Selection toolbar is a hover/mouse affordance — suppress it only when a
  // finger is the active input, so a mouse on a touchscreen laptop keeps it.
  const disableSelectionToolbar = useInputMode() === "touch"
  const editorRef = useRef<RichEditorHandle>(null)
  const savedPrompt = (preferences?.scratchpadCustomPrompt ?? "").trim()
  const [contentJson, setContentJson] = useState<JSONContent>(() => parsePromptMarkdown(savedPrompt))
  const instructions = useCommittedText<HTMLDivElement>({
    saved: savedPrompt,
    commit: (markdown) => updatePreference("scratchpadCustomPrompt", markdown || null, { errorShownInPlace: true }),
    failureMessage: "Couldn't save your instructions",
  })

  // The editor holds rich content and the draft its markdown. When the draft moves without
  // the editor (Escape, a change from another device), the editor follows.
  const editorText = useRef(savedPrompt)
  useEffect(() => {
    if (instructions.value.trim() === editorText.current.trim()) return
    editorText.current = instructions.value
    setContentJson(parsePromptMarkdown(instructions.value))
  }, [instructions.value])

  const onEditorChange = (next: JSONContent) => {
    editorText.current = serializeToMarkdown(next)
    setContentJson(next)
    instructions.onChange(editorText.current)
  }

  return (
    <div className="space-y-8">
      {workspaceId && (
        <SettingsSection section="ai-agents">
          <PersonalDefaultCompanionSection workspaceId={workspaceId} />
          <MyPersonasSection workspaceId={workspaceId} />
          <PersonalSubagentModelsSection workspaceId={workspaceId} />
        </SettingsSection>
      )}

      <SettingsSection section="instructions">
        <SettingRow setting="ai-instructions" labelFor={false} description={<InstructionsScope />}>
          <div
            ref={instructions.fieldRef}
            className="input-glow-wrapper"
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              void instructions.save()
            }}
          >
            <div
              className={cn("relative", SETTING_INPUT_FRAME)}
              onClick={(event) => {
                if (
                  (event.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']")
                ) {
                  return
                }
                editorRef.current?.focus()
              }}
            >
              <RichEditor
                ref={editorRef}
                value={contentJson}
                onChange={onEditorChange}
                onSubmit={() => void instructions.save()}
                placeholder="How should agents think and help in your scratchpads?"
                messageSendMode="cmdEnter"
                disableSelectionToolbar={disableSelectionToolbar}
                ariaLabel="Instructions for your scratchpads"
                ariaErrorMessage={instructions.state.kind === "error" ? INSTRUCTIONS_ERROR_ID : undefined}
                className="min-h-0 pr-6 [&_.tiptap]:min-h-[180px] [&_.tiptap]:max-h-[320px]"
                enableMentions={false}
                enableChannels={false}
                enableCommands={false}
                enableEmoji={false}
              />

              <span className="pointer-events-none absolute right-3 top-3">
                <SaveIndicator state={instructions.state} />
              </span>
            </div>
          </div>
          {instructions.state.kind === "error" && (
            <div className="mt-2">
              <SaveError state={instructions.state} id={INSTRUCTIONS_ERROR_ID} />
            </div>
          )}
        </SettingRow>
      </SettingsSection>
    </div>
  )
}
