import { useId, useState, type ReactNode } from "react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { SETTING_CONTROL_HEIGHT, ScrollEdgeShadows, SettingFieldError } from "@/components/settings/setting-primitives"
import { SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"
import { useScrollEdges } from "@/hooks/use-scroll-edges"
import {
  API_KEY_ELIGIBLE_SCOPES,
  API_KEY_NAME_MAX_LENGTH,
  CURRENT_API_VERSION,
  WORKSPACE_PERMISSIONS,
  isApiKeyEligibleScope,
  type CreateApiKeyInput,
  type UserApiKey,
  type WorkspacePermissionSlug,
} from "@threahq/types"
import { ApiKeyVersionControl } from "./api-key-version-control"
import { ApiKeyPermissionPicker } from "./api-key-permission-picker"
import { eligibleCount } from "./api-key-scopes"

// Full catalog drives SCOPE_LABELS so previously-issued keys with scopes
// outside the eligible picker subset still render a human-readable name.
export const SCOPE_LABELS: Record<string, string> = Object.fromEntries(
  WORKSPACE_PERMISSIONS.map((p) => [p.slug, p.name])
)

const COPY_SUFFIX = " (copy)"

interface ApiKeyDraft {
  name: string
  scopes: ReadonlySet<WorkspacePermissionSlug>
  /** Undefined leaves the pin to the server, which pins its current version. */
  apiVersion?: string | null
  /** Source scopes a new key can no longer be granted. */
  droppedScopes: readonly WorkspacePermissionSlug[]
}

export const NEW_API_KEY_DRAFT: ApiKeyDraft = { name: "", scopes: new Set(), droppedScopes: [] }

export function draftFromKey(key: Pick<UserApiKey, "name" | "scopes" | "apiVersion">): ApiKeyDraft {
  return {
    name: key.name.slice(0, API_KEY_NAME_MAX_LENGTH - COPY_SUFFIX.length) + COPY_SUFFIX,
    scopes: new Set(key.scopes.filter(isApiKeyEligibleScope)),
    apiVersion: key.apiVersion,
    droppedScopes: key.scopes.filter((scope) => !isApiKeyEligibleScope(scope)),
  }
}

/** Desktop: a flex column, so the header and footer stay put and only the body scrolls. */
export const API_KEY_DIALOG_DESKTOP_CLASS = "max-w-xl sm:flex sm:flex-col sm:gap-0 sm:overflow-hidden sm:p-0"
export const API_KEY_DIALOG_HEADER_CLASS = "sm:px-6 sm:pb-4 sm:pt-6"
export const API_KEY_DIALOG_FOOTER_CLASS = "sm:items-center sm:px-6 sm:py-4"

/** The scrolling part of a key dialog, shadowed at an edge its content continues past. */
export function ApiKeyDialogBody({ children }: { children: ReactNode }) {
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const edges = useScrollEdges(body)
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ResponsiveDialogBody ref={setBody} className="min-h-0 space-y-5 pb-5 pt-1 sm:pt-2">
        {children}
      </ResponsiveDialogBody>
      <ScrollEdgeShadows {...edges} />
    </div>
  )
}

/** How many of the key-eligible permissions are picked, announced as it changes. */
export function PermissionCount({ scopes }: { scopes: ReadonlySet<string> }) {
  return (
    <p aria-live="polite" className="text-sm text-muted-foreground max-sm:text-center sm:mr-auto">
      {eligibleCount(scopes)} of {API_KEY_ELIGIBLE_SCOPES.length} permissions
    </p>
  )
}

function createInputFromDraft(draft: ApiKeyDraft): CreateApiKeyInput | null {
  const name = draft.name.trim()
  if (!name || draft.scopes.size === 0) return null
  return { name, scopes: [...draft.scopes], apiVersion: draft.apiVersion }
}

/**
 * Open/close/create lifecycle for {@link ApiKeyCreateDialog}. A create can't be
 * aborted server-side, so the dialog stays open and locked until it settles.
 */
export function useApiKeyCreateForm<TCreated extends { key: { name: string }; value: string }>({
  create,
  onCreated,
}: {
  create: (input: CreateApiKeyInput) => Promise<TCreated>
  onCreated: (created: TCreated) => void
}) {
  const [draft, setDraft] = useState<ApiKeyDraft | null>(null)
  const mutation = useMutation({
    mutationFn: create,
    onSuccess: (created) => {
      setDraft(null)
      onCreated(created)
    },
  })

  const open = (next: ApiKeyDraft) => {
    mutation.reset()
    setDraft(next)
  }

  const form: ApiKeyCreateFormState | null = draft && {
    draft,
    onDraftChange: (next) => {
      if (mutation.isError) mutation.reset()
      setDraft(next)
    },
    isPending: mutation.isPending,
    error: mutation.error,
    onCancel: () => setDraft(null),
    onCreate: (input) => mutation.mutate(input),
  }

  return { isPending: mutation.isPending, open, form }
}

interface ApiKeyCreateFormState {
  draft: ApiKeyDraft
  onDraftChange: (draft: ApiKeyDraft) => void
  isPending: boolean
  error: Error | null
  onCancel: () => void
  onCreate: (input: CreateApiKeyInput) => void
}

interface ApiKeyCreateDialogProps {
  /** The open form, or `null` when the dialog is closed. */
  form: ApiKeyCreateFormState | null
  nameLabel: string
  namePlaceholder: string
}

export function ApiKeyCreateDialog({ form, nameLabel, namePlaceholder }: ApiKeyCreateDialogProps) {
  return (
    <ResponsiveDialog
      open={form !== null}
      onOpenChange={(open) => !open && form && !form.isPending && form.onCancel()}
      disableSnapPoints
      historyEntry={false}
    >
      <ResponsiveDialogContent desktopClassName={API_KEY_DIALOG_DESKTOP_CLASS} drawerClassName="max-h-[92dvh]">
        {form && <ApiKeyCreateFields {...form} nameLabel={nameLabel} namePlaceholder={namePlaceholder} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function ApiKeyCreateFields({
  draft,
  onDraftChange,
  nameLabel,
  namePlaceholder,
  isPending,
  error,
  onCancel,
  onCreate,
}: ApiKeyCreateFormState & { nameLabel: string; namePlaceholder: string }) {
  const nameId = useId()
  const droppedNoteId = useId()
  const hasDroppedScopes = draft.droppedScopes.length > 0
  const input = createInputFromDraft(draft)

  return (
    <>
      <ResponsiveDialogHeader className={API_KEY_DIALOG_HEADER_CLASS}>
        <ResponsiveDialogTitle>New API key</ResponsiveDialogTitle>
        <div className="space-y-2 pt-3 text-left">
          <Label htmlFor={nameId}>{nameLabel}</Label>
          <Input
            id={nameId}
            placeholder={namePlaceholder}
            value={draft.name}
            onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
            disabled={isPending}
            aria-describedby={hasDroppedScopes ? droppedNoteId : undefined}
            className={SETTING_CONTROL_HEIGHT}
          />
        </div>
      </ResponsiveDialogHeader>

      <ApiKeyDialogBody>
        <ApiKeyPermissionPicker
          scopes={draft.scopes}
          onChange={(scopes) => onDraftChange({ ...draft, scopes })}
          disabled={isPending}
        />
        {hasDroppedScopes && (
          <p id={droppedNoteId} className={SETTING_MUTED_NOTE_TEXT}>
            Not copied, no longer available for keys:{" "}
            {draft.droppedScopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(", ")}
          </p>
        )}

        <ApiKeyVersionControl
          apiVersion={draft.apiVersion === undefined ? CURRENT_API_VERSION : draft.apiVersion}
          onChange={(apiVersion) => onDraftChange({ ...draft, apiVersion })}
          disabled={isPending}
        />

        {error && <SettingFieldError>{error.message || "Couldn't create the key. Try again."}</SettingFieldError>}
      </ApiKeyDialogBody>

      <ResponsiveDialogFooter className={API_KEY_DIALOG_FOOTER_CLASS}>
        <PermissionCount scopes={draft.scopes} />
        <Button variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={() => input && onCreate(input)} disabled={!input || isPending}>
          {isPending ? "Creating…" : "Create key"}
        </Button>
      </ResponsiveDialogFooter>
    </>
  )
}
