import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  PERSONA_SYSTEM_PROMPT_MAX_CHARS,
  type AgentToolName,
  type JSONContent,
  type PersonaConfigPatch,
  type PersonaConfigResponse,
  type PersonaModelOption,
} from "@threa/types"
import { ApiError } from "@/api/client"
import type { PersonaOverrideConflict } from "@/api"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { EditorActionBar, RichEditor, type RichEditorHandle } from "@/components/editor"
import { parsePromptMarkdown, serializeToMarkdown } from "@/components/editor/editor-markdown"
import { useInputMode } from "@/hooks/use-input-mode"
import { cn } from "@/lib/utils"
import { EmojiField } from "@/components/labels/label-edit-form"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import {
  personaKeys,
  useDiscardPersonaDraft,
  useSavePersonaDraft,
  useUpdatePersonaOverride,
} from "@/hooks/use-personas"
import {
  applyPatch,
  computeSparsePatch,
  isFieldOverridden,
  patchesEqual,
  syncHintText,
  type PersonaFormValues,
  type SyncState,
} from "./persona-form"
import { FieldRow } from "./field-row"
import { PersonaHistoryPanel } from "./persona-history-panel"
import { ToolChecklist } from "./tool-checklist"

const ESCALATION_NONE = "__none__"

/**
 * The registry-derived assignable models with any off-allowlist ids (a built-in
 * default or the current value) folded in so a legal-but-unlisted model still
 * renders as an item instead of a blank Select trigger. Both the main and
 * escalation model selects go through this — an unlisted escalation default must
 * render too. A folded-in id has no registry label, so it renders as its raw id.
 */
function buildModelOptions(
  available: PersonaModelOption[],
  extras: (string | null | undefined)[]
): PersonaModelOption[] {
  const options: PersonaModelOption[] = available.map((option) => ({ id: option.id, label: option.label }))
  for (const id of extras) {
    if (id && !options.some((option) => option.id === id)) options.unshift({ id, label: id })
  }
  return options
}

interface PersonaEditorFormProps {
  workspaceId: string
  personaId: string
  config: PersonaConfigResponse
  /**
   * Mirror the draft-sync lifecycle up so the test-chat pane can show the same
   * "saving/saved" indicator. The debounce stays owned here (the single driver);
   * this only reflects the resulting state — it is not a second debounce.
   */
  onSyncStateChange?: (sync: SyncState) => void
}

/**
 * The persona editor form (left pane; the test chat mounts to its right in a
 * later step). Holds the resolved editable fields, computes the SPARSE override
 * patch against the built-in defaults, debounces edits into the server draft
 * (what the test chat runs), and commits with optimistic concurrency — a
 * concurrent admin edit surfaces inline (INV-63), never a silent overwrite.
 */
export function PersonaEditorForm({ workspaceId, personaId, config, onSyncStateChange }: PersonaEditorFormProps) {
  const queryClient = useQueryClient()
  const { toEmoji, toShortcode } = useWorkspaceEmoji(workspaceId)
  // Selection toolbar is a hover/mouse affordance; suppress it on touch.
  const disableSelectionToolbar = useInputMode() === "touch"
  const promptEditorRef = useRef<RichEditorHandle>(null)
  const [promptFormatOpen, setPromptFormatOpen] = useState(false)

  const defaults = config.defaults
  const savedValues = useMemo(() => applyPatch(defaults, config.overridePatch), [defaults, config.overridePatch])

  const [values, setValues] = useState<PersonaFormValues>(() =>
    config.draft ? applyPatch(defaults, config.draft.patch) : savedValues
  )
  // The RichEditor's doc for the system prompt. `values.systemPrompt` (markdown)
  // stays the single source of truth for the patch/dirty/counter machinery; this
  // is only the editor's view of it. `lastSerializedRef` records the markdown the
  // editor itself last produced, so the re-seed effect below can tell an external
  // baseline change (reset / discard / adopt-theirs / broadcast) from the user's
  // own typing and only reset the doc for the former — no cursor churn, no loop.
  const [promptJson, setPromptJson] = useState<JSONContent>(() => parsePromptMarkdown(values.systemPrompt))
  const lastSerializedPromptRef = useRef(values.systemPrompt)
  const [conflict, setConflict] = useState(false)
  const [sync, setSync] = useState<SyncState>("idle")
  // Set the local sync state AND mirror it to the parent (the pane's indicator).
  const notifySync = useCallback(
    (next: SyncState) => {
      setSync(next)
      onSyncStateChange?.(next)
    },
    [onSyncStateChange]
  )
  // Only a real edit triggers draft sync — mounting with a loaded draft must not
  // re-POST it, and a broadcast-driven config refetch must not look like typing.
  const editedRef = useRef(false)
  // The saved baseline (patch + updatedAt) this form has reconciled against. A
  // concurrent admin's commit arrives via the workspace `agent_config:updated`
  // broadcast, which refetches this config query and advances `overrideUpdatedAt`
  // under our still-local `values`; reconciling against this ref (see effect below)
  // keeps that from silently re-arming `expectedUpdatedAt` and clobbering them.
  const ackRef = useRef<{ updatedAt: string | null; patch: PersonaConfigPatch }>({
    updatedAt: config.overrideUpdatedAt,
    patch: config.overridePatch ?? {},
  })

  const sparsePatch = useMemo(() => computeSparsePatch(values, defaults), [values, defaults])
  const savedPatch = config.overridePatch ?? {}
  const isDirty = !patchesEqual(sparsePatch, savedPatch)
  // The backend rejects an over-length prompt (400); block the commit locally so
  // the counter's over-limit state is the only signal the user needs to act on.
  const promptOverLimit = values.systemPrompt.length > PERSONA_SYSTEM_PROMPT_MAX_CHARS

  const saveDraft = useSavePersonaDraft(workspaceId, personaId)
  const updateOverride = useUpdatePersonaOverride(workspaceId, personaId)
  const discardDraft = useDiscardPersonaDraft(workspaceId, personaId)

  // Debounced draft sync (~700ms). The ref holds the latest patch so the timeout
  // always sends the current value without re-subscribing the effect.
  const patchRef = useRef(sparsePatch)
  patchRef.current = sparsePatch
  const patchKey = JSON.stringify(sparsePatch)
  useEffect(() => {
    if (!editedRef.current) return
    notifySync("syncing")
    const timer = setTimeout(() => {
      // Save/Discard may have landed while this timer was pending (both reset
      // editedRef); firing then would re-insert a ghost draft row right after
      // the commit transaction deleted it, resurrecting Discard and surviving
      // reload. The at-fire re-check makes the "commit leaves no draft"
      // invariant hold under any edit/Save interleaving.
      if (!editedRef.current) return
      saveDraft.mutate(patchRef.current, {
        onSuccess: () => notifySync("synced"),
        onError: () => notifySync("error"),
      })
    }, 700)
    return () => clearTimeout(timer)
  }, [patchKey])

  // Reconcile an externally-advanced saved baseline (a concurrent admin's commit,
  // delivered via the workspace broadcast that refetches this config query). If the
  // form holds no unsynced work, adopt the new baseline; if it does, surface the
  // conflict banner (offer "load their changes") instead of silently advancing
  // `expectedUpdatedAt` under stale values — that would defeat the 409 guard and
  // clobber the other admin (INV-63). Our own commit advances `ackRef` in
  // `handleSave`, so this is a no-op for it.
  useEffect(() => {
    if (config.overrideUpdatedAt === ackRef.current.updatedAt) return
    const holdsUnsyncedWork = !patchesEqual(computeSparsePatch(values, defaults), ackRef.current.patch)
    ackRef.current = { updatedAt: config.overrideUpdatedAt, patch: config.overridePatch ?? {} }
    if (holdsUnsyncedWork) {
      setConflict(true)
      return
    }
    setValues(applyPatch(defaults, config.overridePatch))
    editedRef.current = false
    setConflict(false)
  }, [config.overrideUpdatedAt, config.overridePatch, defaults, values])

  // Re-seed the prompt editor when `values.systemPrompt` changes to something the
  // editor did not just type — i.e. an external baseline swap (per-field reset,
  // discard, adopt-theirs, or a broadcast-driven config refetch). Skipped for the
  // user's own keystrokes because `handleSystemPromptChange` advances the ref
  // first, so the incoming value matches and this no-ops (no cursor jump / loop).
  useEffect(() => {
    if (values.systemPrompt === lastSerializedPromptRef.current) return
    lastSerializedPromptRef.current = values.systemPrompt
    setPromptJson(parsePromptMarkdown(values.systemPrompt))
  }, [values.systemPrompt])

  const setField = <K extends keyof PersonaFormValues>(field: K, value: PersonaFormValues[K]) => {
    editedRef.current = true
    setValues((prev) => ({ ...prev, [field]: value }))
  }

  const handleSystemPromptChange = (json: JSONContent) => {
    const markdown = serializeToMarkdown(json).trim()
    // Record what the editor produced before the state change re-runs the re-seed
    // effect, so it recognises this as the user's own edit and leaves the doc be.
    lastSerializedPromptRef.current = markdown
    setPromptJson(json)
    setField("systemPrompt", markdown)
  }

  const resetField = <K extends keyof PersonaFormValues>(field: K) => {
    editedRef.current = true
    setValues((prev) => ({ ...prev, [field]: defaults[field] as PersonaFormValues[K] }))
  }

  // Adopt another admin's committed override as the known baseline so the next
  // Save/restore asserts against it (overwrites) — the local edits stay, nothing
  // is lost silently (INV-63). Shared by Save's 409 branch and a restore 409 from
  // the history panel, which both surface the same amber banner.
  const applyOverrideConflict = useCallback(
    (current: PersonaOverrideConflict | null) => {
      queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
        old
          ? {
              ...old,
              overridePatch: current?.patch ?? null,
              overrideUpdatedAt: current?.updatedAt ?? null,
              resolved: { ...old.defaults, ...(current?.patch ?? {}) },
            }
          : old
      )
      setConflict(true)
    },
    [queryClient, workspaceId, personaId]
  )

  const handleSave = () => {
    // Mirror the Save button's disabled guard so the RichEditor's Cmd/Ctrl+Enter
    // (onSubmit) can't commit a save the button would have blocked — an
    // over-limit prompt (400 on the wire) or a no-op write with no dirty changes.
    if (updateOverride.isPending || !isDirty || promptOverLimit) return
    updateOverride.mutate(
      { patch: sparsePatch, expectedUpdatedAt: config.overrideUpdatedAt },
      {
        onSuccess: (result) => {
          editedRef.current = false
          setConflict(false)
          notifySync("idle")
          // Advance the reconciled baseline to what we just committed so the
          // broadcast echo of our own commit is a no-op, not a false conflict.
          ackRef.current = { updatedAt: result.updatedAt, patch: sparsePatch }
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
    if (discardDraft.isPending) return
    discardDraft.mutate(undefined, {
      onSuccess: () => {
        setValues(savedValues)
        editedRef.current = false
        setConflict(false)
        notifySync("idle")
      },
      onError: () => toast.error("Failed to discard changes"),
    })
  }

  const loadTheirChanges = () => {
    setValues(applyPatch(defaults, config.overridePatch))
    editedRef.current = false
    setConflict(false)
  }

  const avatarDisplay = values.avatarEmoji ? (toEmoji(values.avatarEmoji) ?? values.avatarEmoji) : ""
  const handleAvatarChange = (raw: string) => {
    if (!raw) return setField("avatarEmoji", null)
    const shortcode = toShortcode(raw)
    setField("avatarEmoji", shortcode ? `:${shortcode}:` : raw)
  }

  const availableModels = config.availableModels
  const modelOptions = useMemo(
    () => buildModelOptions(availableModels, [values.model, defaults.model]),
    [availableModels, values.model, defaults.model]
  )
  const escalationModelOptions = useMemo(
    () => buildModelOptions(availableModels, [values.escalationModel, defaults.escalationModel]),
    [availableModels, values.escalationModel, defaults.escalationModel]
  )

  const syncHint = syncHintText(sync)

  return (
    <div className="space-y-6">
      {conflict && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Someone else updated this persona while you were editing. Save again to overwrite their version, or{" "}
          <button type="button" className="font-medium underline underline-offset-2" onClick={loadTheirChanges}>
            load their changes
          </button>{" "}
          to start from it.
        </p>
      )}

      <FieldRow
        label="Name"
        htmlFor="persona-name"
        overridden={isFieldOverridden(values, defaults, "name")}
        onReset={() => resetField("name")}
      >
        <Input id="persona-name" value={values.name} onChange={(event) => setField("name", event.target.value)} />
      </FieldRow>

      <FieldRow
        label="Description"
        htmlFor="persona-description"
        overridden={isFieldOverridden(values, defaults, "description")}
        onReset={() => resetField("description")}
      >
        <Textarea
          id="persona-description"
          value={values.description ?? ""}
          onChange={(event) => setField("description", event.target.value || null)}
          rows={2}
        />
      </FieldRow>

      <FieldRow
        label="Avatar"
        overridden={isFieldOverridden(values, defaults, "avatarEmoji")}
        onReset={() => resetField("avatarEmoji")}
      >
        <EmojiField workspaceId={workspaceId} value={avatarDisplay} onChange={handleAvatarChange} />
      </FieldRow>

      <FieldRow
        label="System prompt"
        description="The standing instructions the persona runs on every turn."
        overridden={isFieldOverridden(values, defaults, "systemPrompt")}
        onReset={() => resetField("systemPrompt")}
        headerAction={
          isFieldOverridden(values, defaults, "systemPrompt") ? (
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="text-xs text-muted-foreground underline underline-offset-2">
                  View default
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="max-h-80 w-[min(24rem,90vw)] overflow-y-auto">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Built-in default prompt
                </p>
                <MarkdownContent content={defaults.systemPrompt} className="text-xs" />
              </PopoverContent>
            </Popover>
          ) : undefined
        }
      >
        <div
          className="rounded-lg border border-input bg-card p-3"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']"))
              return
            promptEditorRef.current?.focus()
          }}
        >
          <RichEditor
            ref={promptEditorRef}
            value={promptJson}
            onChange={handleSystemPromptChange}
            onSubmit={handleSave}
            placeholder="How should this persona think and respond?"
            messageSendMode="cmdEnter"
            staticToolbarOpen={promptFormatOpen}
            disableSelectionToolbar={disableSelectionToolbar}
            ariaLabel="Persona system prompt editor"
            className="min-h-0 [&_.tiptap]:min-h-[200px] [&_.tiptap]:max-h-[420px]"
            enableMentions={false}
            enableChannels={false}
            enableCommands={false}
            enableEmoji={false}
          />
          <div className="mt-2 border-t pt-2" onMouseDown={(event) => event.preventDefault()}>
            <EditorActionBar
              editorHandle={promptEditorRef.current}
              formatOpen={promptFormatOpen}
              onFormatOpenChange={setPromptFormatOpen}
              showAttach={false}
              showMention={false}
              showEmoji={false}
              trailingContent={
                <span className={cn("text-[11px] text-muted-foreground", promptOverLimit && "text-destructive")}>
                  {values.systemPrompt.length}/{PERSONA_SYSTEM_PROMPT_MAX_CHARS}
                </span>
              }
            />
          </div>
        </div>
      </FieldRow>

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
        label="Escalation model"
        description="Used for harder turns. None disables escalation."
        overridden={isFieldOverridden(values, defaults, "escalationModel")}
        onReset={() => resetField("escalationModel")}
      >
        <Select
          value={values.escalationModel ?? ESCALATION_NONE}
          onValueChange={(value) => setField("escalationModel", value === ESCALATION_NONE ? null : value)}
        >
          <SelectTrigger className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ESCALATION_NONE}>None (no escalation)</SelectItem>
            {escalationModelOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow
        label="Temperature"
        htmlFor="persona-temperature"
        description="Sampling randomness, 0–2. Empty uses the provider default."
        overridden={isFieldOverridden(values, defaults, "temperature")}
        onReset={() => resetField("temperature")}
      >
        <Input
          id="persona-temperature"
          type="number"
          min={0}
          max={2}
          step={0.1}
          className="w-32"
          value={values.temperature ?? ""}
          onChange={(event) => setField("temperature", event.target.value === "" ? null : Number(event.target.value))}
        />
      </FieldRow>

      <FieldRow
        label="Max tokens"
        htmlFor="persona-max-tokens"
        description="Cap on a single reply. Empty uses the provider default."
        overridden={isFieldOverridden(values, defaults, "maxTokens")}
        onReset={() => resetField("maxTokens")}
      >
        <Input
          id="persona-max-tokens"
          type="number"
          min={1}
          step={1}
          className="w-40"
          value={values.maxTokens ?? ""}
          onChange={(event) =>
            setField("maxTokens", event.target.value === "" ? null : Math.trunc(Number(event.target.value)))
          }
        />
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

      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-background py-3">
        <div className="flex items-center gap-3">
          <PersonaHistoryPanel
            workspaceId={workspaceId}
            personaId={personaId}
            expectedUpdatedAt={config.overrideUpdatedAt}
            onOverrideConflict={applyOverrideConflict}
          />
          <span className="text-[11px] text-muted-foreground" aria-live="polite">
            {syncHint}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={discardDraft.isPending || (!config.draft && !isDirty)}
              >
                Discard
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard draft changes?</AlertDialogTitle>
                <AlertDialogDescription>
                  All unsaved edits revert to the last saved configuration, and any open test chat ends. This cannot be
                  undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep editing</AlertDialogCancel>
                <AlertDialogAction onClick={handleDiscard}>Discard</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={updateOverride.isPending || !isDirty || promptOverLimit}
          >
            {updateOverride.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  )
}
