import { useCallback, useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ChevronDown } from "lucide-react"
import type { AgentToolName, PersonaConfigResponse } from "@threa/types"
import { ApiError } from "@/api/client"
import type { PersonaCustomConflict, PersonaOverrideConflict } from "@/api"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { cn } from "@/lib/utils"
import { PersonaAvatar } from "@/components/persona-avatar"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { personaKeys, useUpdatePersonaOverride } from "@/hooks/use-personas"
import { BUILTIN_EDITABLE_FIELDS, buildModelOptions, isFieldOverridden } from "./persona-form"
import type { SyncState } from "./persona-form"
import { usePersonaDraftEditor } from "./use-persona-draft-editor"
import { PersonaConflictBanner } from "./persona-conflict-banner"
import { PersonaEditorFooter } from "./persona-editor-footer"
import { BREVITY_PRESET_OPTIONS, TONE_PRESET_OPTIONS } from "./persona-style-presets"
import { FieldRow } from "./field-row"
import { ToolChecklist } from "./tool-checklist"

const PRESET_DEFAULT = "__default__"

interface PersonaEditorFormProps {
  workspaceId: string
  personaId: string
  config: PersonaConfigResponse
  onSyncStateChange?: (sync: SyncState) => void
}

/**
 * The restricted editor for a BUILT-IN (system) persona: identity and prompt are
 * locked; only the toolset, model, and the two style PRESETS are editable. It
 * computes the SPARSE override patch against the built-in defaults — restricted
 * to `BUILTIN_EDITABLE_FIELDS` so a locked field can never enter it (the backend
 * 400s `PERSONA_FIELD_LOCKED`) — debounces edits into the server draft, and
 * commits with optimistic concurrency (a concurrent admin edit surfaces inline,
 * INV-63). Custom personas render the full {@link CustomPersonaEditor} instead.
 */
export function PersonaEditorForm({ workspaceId, personaId, config, onSyncStateChange }: PersonaEditorFormProps) {
  const queryClient = useQueryClient()
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const defaults = config.defaults!
  const [promptOpen, setPromptOpen] = useState(false)

  const editor = usePersonaDraftEditor({
    workspaceId,
    personaId,
    baseline: defaults,
    savedPatch: config.overridePatch,
    draftPatch: config.draft?.patch ?? null,
    editableFields: BUILTIN_EDITABLE_FIELDS,
    overrideUpdatedAt: config.overrideUpdatedAt,
    onSyncStateChange,
  })
  const { values, setField, resetField, sparsePatch, isDirty, sync, conflict, setConflict } = editor

  const updateOverride = useUpdatePersonaOverride(workspaceId, personaId)

  const modelOptions = useMemo(
    () => buildModelOptions(config.availableModels, [values.model, defaults.model]),
    [config.availableModels, values.model, defaults.model]
  )

  // Adopt another admin's committed override as the known baseline (Save/restore
  // 409). The local edits stay; nothing is lost silently (INV-63).
  const applyOverrideConflict = useCallback(
    (current: PersonaOverrideConflict | PersonaCustomConflict | null) => {
      // A built-in conflict always carries a sparse patch; ignore the custom shape.
      const patch = current && "patch" in current ? current.patch : null
      queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
        old
          ? {
              ...old,
              overridePatch: patch,
              overrideUpdatedAt: current?.updatedAt ?? null,
              resolved: { ...old.defaults!, ...(patch ?? {}) },
            }
          : old
      )
      setConflict(true)
    },
    [queryClient, workspaceId, personaId, setConflict]
  )

  const handleSave = () => {
    if (updateOverride.isPending || !isDirty) return
    updateOverride.mutate(
      { patch: sparsePatch, expectedUpdatedAt: config.overrideUpdatedAt },
      {
        onSuccess: (result) => {
          editor.commitAck(result.updatedAt, values)
          setConflict(false)
          editor.notifySync("idle")
        },
        onError: (error) => {
          if (ApiError.isApiError(error) && error.code === "PERSONA_OVERRIDE_CONFLICT") {
            applyOverrideConflict((error.details?.current ?? null) as PersonaOverrideConflict | null)
            return
          }
          toast.error(error instanceof Error ? error.message : "Failed to save persona")
        },
      }
    )
  }

  const handleDiscard = () => {
    if (editor.discardDraft.isPending) return
    editor.discardDraft.mutate(undefined, {
      onSuccess: () => {
        editor.resetToSaved()
        editor.notifySync("idle")
      },
      onError: () => toast.error("Failed to discard changes"),
    })
  }

  const avatarFallback =
    (defaults.avatarEmoji && (toEmoji(defaults.avatarEmoji) ?? defaults.avatarEmoji)) || defaults.name.charAt(0)

  return (
    <div className="space-y-6">
      {conflict && <PersonaConflictBanner onLoadTheirs={editor.resetToSaved} />}

      <div className="flex items-center gap-3 rounded-lg border border-input bg-card p-3">
        <PersonaAvatar slug={defaults.slug} fallback={avatarFallback} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{defaults.name}</p>
          {defaults.description && <p className="truncate text-xs text-muted-foreground">{defaults.description}</p>}
        </div>
        <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">Built-in</span>
      </div>

      <FieldRow
        label="Model"
        overridden={isFieldOverridden(values, defaults, "model")}
        onReset={() => resetField("model")}
      >
        <Select value={values.model} onValueChange={(value) => setField("model", value)}>
          <SelectTrigger className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow
        label="Tone"
        description="How the persona sounds."
        overridden={isFieldOverridden(values, defaults, "tonePreset")}
        onReset={() => resetField("tonePreset")}
      >
        <Select
          value={values.tonePreset ?? PRESET_DEFAULT}
          onValueChange={(value) => setField("tonePreset", value === PRESET_DEFAULT ? null : (value as never))}
        >
          <SelectTrigger className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TONE_PRESET_OPTIONS.map((option) => (
              <SelectItem key={option.value ?? PRESET_DEFAULT} value={option.value ?? PRESET_DEFAULT}>
                <span className="font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow
        label="Brevity"
        description="How long its replies run."
        overridden={isFieldOverridden(values, defaults, "brevityPreset")}
        onReset={() => resetField("brevityPreset")}
      >
        <Select
          value={values.brevityPreset ?? PRESET_DEFAULT}
          onValueChange={(value) => setField("brevityPreset", value === PRESET_DEFAULT ? null : (value as never))}
        >
          <SelectTrigger className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BREVITY_PRESET_OPTIONS.map((option) => (
              <SelectItem key={option.value ?? PRESET_DEFAULT} value={option.value ?? PRESET_DEFAULT}>
                <span className="font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow
        label="Tools"
        description="Which tools the persona may call."
        overridden={isFieldOverridden(values, defaults, "enabledTools")}
        onReset={() => resetField("enabledTools")}
      >
        <ToolChecklist
          value={values.enabledTools}
          defaults={defaults.enabledTools}
          onChange={(next: AgentToolName[]) => setField("enabledTools", next)}
        />
      </FieldRow>

      <Collapsible open={promptOpen} onOpenChange={setPromptOpen} className="space-y-2">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
          <span>System prompt</span>
          <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
            Read-only
            <ChevronDown className={cn("h-4 w-4 transition-transform", promptOpen && "rotate-180")} />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="max-h-96 overflow-y-auto rounded-lg border border-input bg-muted/40 p-3">
            <MarkdownContent content={defaults.systemPrompt} className="text-xs" />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <PersonaEditorFooter
        workspaceId={workspaceId}
        personaId={personaId}
        kind="builtin"
        expectedUpdatedAt={config.overrideUpdatedAt}
        onOverrideConflict={applyOverrideConflict}
        sync={sync}
        discardDisabled={editor.discardDraft.isPending || (!config.draft && !isDirty)}
        onDiscard={handleDiscard}
        saveDisabled={updateOverride.isPending || !isDirty}
        savePending={updateOverride.isPending}
        onSave={handleSave}
      />
    </div>
  )
}
