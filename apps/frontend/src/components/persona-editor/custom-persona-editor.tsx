import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { FileText, Paperclip, Upload, X } from "lucide-react"
import {
  getPersonaAvatarUrl,
  isPersonaAttachmentMimeAllowed,
  PERSONA_ATTACHMENT_ALLOWED_MIME_PREFIXES,
  PERSONA_ATTACHMENT_ALLOWED_MIME_TYPES,
  PERSONA_ATTACHMENT_MAX_COUNT,
  PERSONA_ATTACHMENT_MAX_SIZE_BYTES,
  PERSONA_DESCRIPTION_MAX_CHARS,
  PERSONA_NAME_MAX_CHARS,
  PERSONA_SLOT_MAX_CHARS,
  PERSONA_SYSTEM_PROMPT_MAX_CHARS,
  type AgentToolName,
  type JSONContent,
  type PersonaAttachmentContextMode,
  type PersonaConfigResponse,
} from "@threa/types"
import { ApiError } from "@/api/client"
import type { PersonaCustomConflict, PersonaOverrideConflict } from "@/api"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EditorActionBar, RichEditor, type RichEditorHandle } from "@/components/editor"
import { parsePromptMarkdown, serializeToMarkdown } from "@/components/editor/editor-markdown"
import { EmojiField } from "@/components/labels/label-edit-form"
import { PersonaAvatar } from "@/components/persona-avatar"
import { useInputMode } from "@/hooks/use-input-mode"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { cn } from "@/lib/utils"
import { formatFileSize } from "@/lib/file-size"
import {
  personaKeys,
  useArchivePersona,
  useDeletePersonaAttachment,
  useRemovePersonaAvatar,
  useUpdatePersonaCustom,
  useUploadPersonaAvatar,
} from "@/hooks/use-personas"
import { AttachExistingDialog } from "./attach-existing-dialog"
import { buildModelOptions, toCustomConfig, CUSTOM_EDITABLE_FIELDS } from "./persona-form"
import type { SyncState } from "./persona-form"
import { usePersonaDraftEditor } from "./use-persona-draft-editor"
import { usePersonaKnowledgeUploads } from "./use-persona-knowledge-uploads"
import { PersonaConflictBanner } from "./persona-conflict-banner"
import { PersonaEditorFooter } from "./persona-editor-footer"
import { ToolChecklist } from "./tool-checklist"

const ESCALATION_NONE = "__none__"

/** How a ready attachment's context mode reads in the row (INV-46 — words from the structured value). */
const CONTEXT_MODE_LABEL: Record<PersonaAttachmentContextMode, string> = {
  full: "In full",
  summary: "Summary only",
  name_only: "Name only",
}

/** Hover explanation for each context label: the budget is invisible otherwise,
 *  and "Summary only" reads as a silent downgrade without the why. */
const CONTEXT_MODE_HINT: Record<PersonaAttachmentContextMode, string> = {
  full: "The file's full text is in the persona's context.",
  summary:
    "Too large to include in full, so the persona gets a short summary. Smaller or fewer files are included in full.",
  name_only: "The persona's knowledge budget is used up, so only the filename is included.",
}

/** The file input's `accept` — the persona-attachment mime allowlist (INV-33 source). */
const PERSONA_ATTACHMENT_ACCEPT = [
  ...PERSONA_ATTACHMENT_ALLOWED_MIME_PREFIXES.map((prefix) => `${prefix}*`),
  ...PERSONA_ATTACHMENT_ALLOWED_MIME_TYPES,
].join(",")

/**
 * Narrow the 409's opaque `details.current` to a custom conflict at runtime — a
 * differently-shaped payload (e.g. a built-in's sparse patch) resolves to null
 * and surfaces the mismatch rather than silently falling through to the old
 * resolved config.
 */
function asCustomConflict(current: unknown): PersonaCustomConflict | null {
  return typeof current === "object" && current !== null && "config" in current && "updatedAt" in current
    ? (current as PersonaCustomConflict)
    : null
}

interface CustomPersonaEditorProps {
  workspaceId: string
  personaId: string
  config: PersonaConfigResponse
  onSyncStateChange?: (sync: SyncState) => void
  /** Where to navigate after archiving. A workspace custom returns to the admin
   *  roster (`?ws-settings=ai-agents`); a personal persona returns to its owner's
   *  personal settings AI tab (`?settings=ai`), which a non-admin can actually
   *  open. Defaults to the admin roster. */
  returnTo?: string
}

/**
 * The full editor for a CUSTOM (workspace) persona: every field is editable and a
 * Save writes the whole config verbatim (there is no defaults baseline / v0
 * floor). Optimistic concurrency runs off the row's `updatedAt`; a concurrent
 * admin's commit surfaces the inline conflict banner (INV-63). Drafts (a sparse
 * diff over the row), the test-drive pane, and the History panel are the same
 * substrate the built-in editor uses. Built-ins render the restricted
 * `PersonaEditorForm` instead.
 */
export function CustomPersonaEditor({
  workspaceId,
  personaId,
  config,
  onSyncStateChange,
  returnTo = `/w/${workspaceId}?ws-settings=ai-agents`,
}: CustomPersonaEditorProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { toEmoji, toShortcode } = useWorkspaceEmoji(workspaceId)
  const disableSelectionToolbar = useInputMode() === "touch"
  const promptEditorRef = useRef<RichEditorHandle>(null)
  const [promptFormatOpen, setPromptFormatOpen] = useState(false)
  const [attachExistingOpen, setAttachExistingOpen] = useState(false)

  const resolved = config.resolved
  const editor = usePersonaDraftEditor({
    workspaceId,
    personaId,
    baseline: resolved,
    savedPatch: null,
    draftPatch: config.draft?.patch ?? null,
    editableFields: CUSTOM_EDITABLE_FIELDS,
    overrideUpdatedAt: config.overrideUpdatedAt,
    onSyncStateChange,
  })
  const { values, setField, sync, conflict, setConflict, isDirty } = editor

  const [promptJson, setPromptJson] = useState<JSONContent>(() => parsePromptMarkdown(values.systemPrompt))
  const lastSerializedPromptRef = useRef(values.systemPrompt)
  // Re-seed the prompt editor only on an external baseline swap (discard,
  // load-their-changes, broadcast refetch) — the user's own keystrokes advance
  // the ref first so the incoming value matches and this no-ops (no cursor churn).
  useEffect(() => {
    if (values.systemPrompt === lastSerializedPromptRef.current) return
    lastSerializedPromptRef.current = values.systemPrompt
    setPromptJson(parsePromptMarkdown(values.systemPrompt))
  }, [values.systemPrompt])

  const handleSystemPromptChange = (json: JSONContent) => {
    const markdown = serializeToMarkdown(json).trim()
    lastSerializedPromptRef.current = markdown
    setPromptJson(json)
    setField("systemPrompt", markdown)
  }

  const update = useUpdatePersonaCustom(workspaceId, personaId)
  const uploadAvatar = useUploadPersonaAvatar(workspaceId, personaId)
  const removeAvatar = useRemovePersonaAvatar(workspaceId, personaId)
  const knowledge = usePersonaKnowledgeUploads(workspaceId, personaId)
  const deleteAttachment = useDeletePersonaAttachment(workspaceId, personaId)
  const archive = useArchivePersona(workspaceId)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  // The cap counts committed rows AND in-flight uploads, so rapid picks can't
  // overrun it while binds are still landing.
  const attachmentCount = config.attachments.length + knowledge.rows.length
  const remainingSlots = PERSONA_ATTACHMENT_MAX_COUNT - attachmentCount
  const atAttachmentCap = remainingSlots <= 0

  const modelOptions = useMemo(
    () => buildModelOptions(config.availableModels, [values.model, resolved.model]),
    [config.availableModels, values.model, resolved.model]
  )
  const escalationOptions = useMemo(
    () => buildModelOptions(config.availableModels, [values.escalationModel, resolved.escalationModel]),
    [config.availableModels, values.escalationModel, resolved.escalationModel]
  )

  const nameValid = values.name.trim().length > 0 && values.name.length <= PERSONA_NAME_MAX_CHARS
  const promptValid = values.systemPrompt.length > 0 && values.systemPrompt.length <= PERSONA_SYSTEM_PROMPT_MAX_CHARS
  const withinCaps =
    (values.description?.length ?? 0) <= PERSONA_DESCRIPTION_MAX_CHARS &&
    (values.tonePrompt?.length ?? 0) <= PERSONA_SLOT_MAX_CHARS &&
    (values.brevityPrompt?.length ?? 0) <= PERSONA_SLOT_MAX_CHARS
  const canSave = isDirty && nameValid && promptValid && withinCaps && !update.isPending

  // Adopt another admin's committed config as the known baseline (Save/restore
  // 409). Local edits stay; nothing is lost silently (INV-63).
  const applyCustomConflict = useCallback(
    (current: PersonaOverrideConflict | PersonaCustomConflict | null) => {
      const next = current && "config" in current ? current.config : null
      queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
        old
          ? {
              ...old,
              overrideUpdatedAt: current?.updatedAt ?? old.overrideUpdatedAt,
              resolved: next ?? old.resolved,
            }
          : old
      )
      setConflict(true)
    },
    [queryClient, workspaceId, personaId, setConflict]
  )

  const handleSave = () => {
    if (!canSave) return
    update.mutate(
      { config: toCustomConfig(values), expectedUpdatedAt: config.overrideUpdatedAt },
      {
        onSuccess: (result) => {
          editor.commitAck(result.updatedAt, values)
          setConflict(false)
          editor.notifySync("idle")
        },
        onError: (error) => {
          if (ApiError.isApiError(error) && error.code === "PERSONA_OVERRIDE_CONFLICT") {
            applyCustomConflict(asCustomConflict(error.details?.current))
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

  const handleArchive = () => {
    if (archive.isPending) return
    archive.mutate(personaId, {
      onSuccess: () => navigate(returnTo),
      onError: () => toast.error("Failed to archive persona"),
    })
  }

  const avatarEmojiDisplay = values.avatarEmoji ? (toEmoji(values.avatarEmoji) ?? values.avatarEmoji) : ""
  const handleEmojiChange = (raw: string) => {
    if (!raw) return setField("avatarEmoji", null)
    const shortcode = toShortcode(raw)
    setField("avatarEmoji", shortcode ? `:${shortcode}:` : raw)
  }
  const handleAvatarFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) uploadAvatar.mutate(file, { onError: () => toast.error("Failed to upload image") })
    event.target.value = ""
  }
  const avatarImageUrl = getPersonaAvatarUrl(workspaceId, resolved.avatarUrl, 64)

  const handleAttachmentFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (picked.length === 0) return

    // Pre-check against the same mime/size rules the server enforces so a doomed
    // upload never starts (INV-11 — loud, no silent drops).
    const valid: File[] = []
    const rejected: string[] = []
    for (const file of picked) {
      if (!isPersonaAttachmentMimeAllowed(file.type)) rejected.push(`${file.name} (unsupported type)`)
      else if (file.size > PERSONA_ATTACHMENT_MAX_SIZE_BYTES)
        rejected.push(`${file.name} (over ${formatFileSize(PERSONA_ATTACHMENT_MAX_SIZE_BYTES)})`)
      else valid.push(file)
    }
    if (rejected.length > 0) toast.error(`Can't add ${rejected.join(", ")}`)

    // Never overrun the cap: take the first N that fit and say what was dropped.
    const accepted = valid.slice(0, Math.max(remainingSlots, 0))
    if (accepted.length < valid.length) {
      toast.error(`Only ${remainingSlots} more file${remainingSlots === 1 ? "" : "s"} can be added`)
    }
    knowledge.addFiles(accepted)
  }
  const handleRemoveAttachment = (attachmentId: string) => {
    deleteAttachment.mutate(attachmentId, { onError: () => toast.error("Failed to remove file") })
  }

  return (
    <div className="space-y-6">
      {conflict && <PersonaConflictBanner onLoadTheirs={editor.resetToSaved} />}

      <div className="space-y-1.5">
        <Label htmlFor="persona-name">Name</Label>
        <Input
          id="persona-name"
          value={values.name}
          maxLength={PERSONA_NAME_MAX_CHARS}
          onChange={(event) => setField("name", event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="persona-description">Description</Label>
        <Textarea
          id="persona-description"
          value={values.description ?? ""}
          rows={2}
          maxLength={PERSONA_DESCRIPTION_MAX_CHARS}
          onChange={(event) => setField("description", event.target.value || null)}
        />
      </div>

      <div className="space-y-2">
        <Label>Avatar</Label>
        <div className="flex items-center gap-3">
          <PersonaAvatar
            slug={resolved.slug}
            avatarUrl={avatarImageUrl}
            fallback={avatarEmojiDisplay || values.name.charAt(0)}
            size="lg"
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => avatarInputRef.current?.click()}
              disabled={uploadAvatar.isPending}
            >
              <Upload className="mr-1 h-3.5 w-3.5" />
              {uploadAvatar.isPending ? "Uploading…" : "Upload image"}
            </Button>
            {resolved.avatarUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => removeAvatar.mutate(undefined, { onError: () => toast.error("Failed to remove image") })}
                disabled={removeAvatar.isPending}
              >
                <X className="mr-1 h-3.5 w-3.5" />
                Remove
              </Button>
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleAvatarFile}
          />
        </div>
        <EmojiField workspaceId={workspaceId} value={avatarEmojiDisplay} onChange={handleEmojiChange} />
        <p className="text-xs text-muted-foreground">
          An uploaded image takes precedence; the emoji is the fallback. JPEG, PNG, or WebP.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>System prompt</Label>
        <p className="text-xs text-muted-foreground">The standing instructions the persona runs on every turn.</p>
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
                <span className={cn("text-[11px] text-muted-foreground", !promptValid && "text-destructive")}>
                  {values.systemPrompt.length}/{PERSONA_SYSTEM_PROMPT_MAX_CHARS}
                </span>
              }
            />
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="persona-tone">Tone</Label>
        <p className="text-xs text-muted-foreground">Overrides the default tone guidance.</p>
        <Textarea
          id="persona-tone"
          value={values.tonePrompt ?? ""}
          rows={2}
          maxLength={PERSONA_SLOT_MAX_CHARS}
          onChange={(event) => setField("tonePrompt", event.target.value || null)}
        />
        <p className="text-right text-[11px] text-muted-foreground">
          {values.tonePrompt?.length ?? 0}/{PERSONA_SLOT_MAX_CHARS}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="persona-brevity">Brevity</Label>
        <p className="text-xs text-muted-foreground">Overrides the default brevity guidance.</p>
        <Textarea
          id="persona-brevity"
          value={values.brevityPrompt ?? ""}
          rows={2}
          maxLength={PERSONA_SLOT_MAX_CHARS}
          onChange={(event) => setField("brevityPrompt", event.target.value || null)}
        />
        <p className="text-right text-[11px] text-muted-foreground">
          {values.brevityPrompt?.length ?? 0}/{PERSONA_SLOT_MAX_CHARS}
        </p>
      </div>

      <div className="space-y-2">
        <Label>Knowledge</Label>
        <p className="text-xs text-muted-foreground">
          Files the persona always carries in its context. Text, PDF, Word, Excel, or JSON. Large files are carried as
          short summaries so everything fits the persona&apos;s knowledge budget.
        </p>
        {(config.attachments.length > 0 || knowledge.rows.length > 0) && (
          <ul className="space-y-1.5">
            {config.attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex items-center gap-3 rounded-lg border border-input bg-card px-3 py-2"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{attachment.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(attachment.sizeBytes)}
                    {attachment.processingStatus === "processing" && " · Processing…"}
                    {attachment.processingStatus === "ready" && attachment.contextMode && (
                      <span title={CONTEXT_MODE_HINT[attachment.contextMode]}>
                        {` · ${CONTEXT_MODE_LABEL[attachment.contextMode]}`}
                      </span>
                    )}
                    {attachment.processingStatus === "failed" && (
                      <span className="text-destructive">
                        {" "}
                        · Couldn&apos;t read this file. Remove it and try a different format.
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                  aria-label={`Remove ${attachment.filename}`}
                  disabled={deleteAttachment.isPending}
                  onClick={() => handleRemoveAttachment(attachment.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
            {knowledge.rows.map((row) => (
              <li key={row.jobId} className="flex items-center gap-3 rounded-lg border border-input bg-card px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{row.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(row.sizeBytes)}
                    {row.status === "uploading" && ` · Uploading… ${Math.round(row.progress * 100)}%`}
                    {row.status === "error" && (
                      <span className="text-destructive"> · {row.error ?? "Upload failed"}</span>
                    )}
                  </p>
                </div>
                {row.status === "error" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0"
                    onClick={() => knowledge.retry(row.jobId)}
                  >
                    Retry
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                  aria-label={`Cancel ${row.filename}`}
                  onClick={() => knowledge.cancel(row.jobId)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => attachmentInputRef.current?.click()}
            disabled={atAttachmentCap}
          >
            <Upload className="mr-1 h-3.5 w-3.5" />
            Add file
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAttachExistingOpen(true)}
            disabled={atAttachmentCap}
          >
            <Paperclip className="mr-1 h-3.5 w-3.5" />
            Attach existing
          </Button>
          <span className="text-xs text-muted-foreground">
            {attachmentCount} of {PERSONA_ATTACHMENT_MAX_COUNT} files
          </span>
        </div>
        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          accept={PERSONA_ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={handleAttachmentFile}
        />
        <AttachExistingDialog
          workspaceId={workspaceId}
          personaId={personaId}
          open={attachExistingOpen}
          onOpenChange={setAttachExistingOpen}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Tools</Label>
        <ToolChecklist
          value={values.enabledTools}
          defaults={resolved.enabledTools}
          onChange={(next: AgentToolName[]) => setField("enabledTools", next)}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Model</Label>
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
      </div>

      <div className="space-y-1.5">
        <Label>Escalation model</Label>
        <p className="text-xs text-muted-foreground">Used for harder turns. None disables escalation.</p>
        <Select
          value={values.escalationModel ?? ESCALATION_NONE}
          onValueChange={(value) => setField("escalationModel", value === ESCALATION_NONE ? null : value)}
        >
          <SelectTrigger className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ESCALATION_NONE}>None (no escalation)</SelectItem>
            {escalationOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap gap-6">
        <div className="space-y-1.5">
          <Label htmlFor="persona-temperature">Temperature</Label>
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
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="persona-max-tokens">Max tokens</Label>
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
        </div>
      </div>

      <div className="rounded-lg border border-destructive/30 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Archive persona</p>
            <p className="text-xs text-muted-foreground">
              Removes it from the roster and companion picker. Streams using it fall back to the built-in companion.
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={archive.isPending}>
                Archive
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive this persona?</AlertDialogTitle>
                <AlertDialogDescription>
                  It stops appearing in the roster and companion picker. You can restore it from the roster&apos;s
                  Archived list this session.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleArchive}>Archive</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <PersonaEditorFooter
        workspaceId={workspaceId}
        personaId={personaId}
        kind="custom"
        expectedUpdatedAt={config.overrideUpdatedAt}
        onOverrideConflict={applyCustomConflict}
        sync={sync}
        discardDisabled={editor.discardDraft.isPending || (!config.draft && !isDirty)}
        onDiscard={handleDiscard}
        saveDisabled={!canSave}
        savePending={update.isPending}
        onSave={handleSave}
      />
    </div>
  )
}
