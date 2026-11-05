import { useId, useState } from "react"
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
import { SETTING_CONTROL_HEIGHT, SettingFieldError } from "@/components/settings/setting-primitives"
import { SettingCheckboxList } from "@/components/settings/setting-lists"
import { SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"
import {
  API_KEY_ELIGIBLE_PICKER_SCOPES,
  API_KEY_NAME_MAX_LENGTH,
  CURRENT_API_VERSION,
  WORKSPACE_PERMISSIONS,
  isApiKeyEligibleScope,
  type CreateApiKeyInput,
  type UserApiKey,
  type WorkspacePermissionSlug,
} from "@threahq/types"
import { ApiKeyVersionControl } from "./api-key-version-control"

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

function setDraftScope(draft: ApiKeyDraft, scope: WorkspacePermissionSlug, checked: boolean): ApiKeyDraft {
  const scopes = new Set(draft.scopes)
  if (checked) scopes.add(scope)
  else scopes.delete(scope)
  return { ...draft, scopes }
}

export const API_KEY_SCOPE_ITEMS = API_KEY_ELIGIBLE_PICKER_SCOPES.map((perm) => ({
  value: perm.slug,
  label: perm.name,
  description: perm.description,
}))

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
      <ResponsiveDialogContent desktopClassName="max-w-md" drawerClassName="max-h-[92dvh]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>New API key</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
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
  const permissionsId = useId()
  const droppedNoteId = useId()
  const hasDroppedScopes = draft.droppedScopes.length > 0
  const input = createInputFromDraft(draft)

  return (
    <>
      <ResponsiveDialogBody className="min-h-0 space-y-5">
        <div className="space-y-2">
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

        <div className="space-y-1">
          <p id={permissionsId} className="text-sm font-medium">
            Permissions
          </p>
          <SettingCheckboxList
            aria-labelledby={permissionsId}
            items={API_KEY_SCOPE_ITEMS}
            selected={draft.scopes}
            disabled={isPending}
            onCheckedChange={(scope, checked) => onDraftChange(setDraftScope(draft, scope, checked))}
          />
          {hasDroppedScopes && (
            <p id={droppedNoteId} className={SETTING_MUTED_NOTE_TEXT}>
              Not copied, no longer available for keys:{" "}
              {draft.droppedScopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(", ")}
            </p>
          )}
        </div>

        <ApiKeyVersionControl
          apiVersion={draft.apiVersion === undefined ? CURRENT_API_VERSION : draft.apiVersion}
          onChange={(apiVersion) => onDraftChange({ ...draft, apiVersion })}
          disabled={isPending}
        />

        {error && <SettingFieldError>{error.message || "Couldn't create the key. Try again."}</SettingFieldError>}
      </ResponsiveDialogBody>

      <ResponsiveDialogFooter>
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
