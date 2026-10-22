import { useId, useRef, useState, type Ref } from "react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
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

export interface ApiKeyDraft {
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

function toggleDraftScope(draft: ApiKeyDraft, scope: WorkspacePermissionSlug): ApiKeyDraft {
  const scopes = new Set(draft.scopes)
  if (scopes.has(scope)) scopes.delete(scope)
  else scopes.add(scope)
  return { ...draft, scopes }
}

function createInputFromDraft(draft: ApiKeyDraft): CreateApiKeyInput | null {
  const name = draft.name.trim()
  if (!name || draft.scopes.size === 0) return null
  return { name, scopes: [...draft.scopes], apiVersion: draft.apiVersion }
}

/**
 * Open/close/create lifecycle for {@link ApiKeyCreateForm}. A create can't be
 * aborted server-side, so the form stays open and locked until it settles.
 */
export function useApiKeyCreateForm<TCreated extends { key: { name: string }; value: string }>({
  create,
  onCreated,
}: {
  create: (input: CreateApiKeyInput) => Promise<TCreated>
  onCreated: (created: TCreated) => void
}) {
  const [draft, setDraft] = useState<ApiKeyDraft | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
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
    // An already-open form keeps its mounted input, so autoFocus won't bring it back into view.
    nameInputRef.current?.focus()
  }

  const formProps: Omit<ApiKeyCreateFormProps, "nameLabel" | "namePlaceholder"> | null = draft && {
    draft,
    onDraftChange: (next) => {
      if (mutation.isError) mutation.reset()
      setDraft(next)
    },
    nameInputRef,
    isPending: mutation.isPending,
    error: mutation.error,
    onCancel: () => setDraft(null),
    onCreate: (input) => mutation.mutate(input),
  }

  return { isOpen: draft !== null, isPending: mutation.isPending, open, formProps }
}

interface ApiKeyCreateFormProps {
  draft: ApiKeyDraft
  onDraftChange: (draft: ApiKeyDraft) => void
  nameInputRef: Ref<HTMLInputElement>
  nameLabel: string
  namePlaceholder: string
  isPending: boolean
  error: Error | null
  onCancel: () => void
  onCreate: (input: CreateApiKeyInput) => void
}

export function ApiKeyCreateForm({
  draft,
  onDraftChange,
  nameInputRef,
  nameLabel,
  namePlaceholder,
  isPending,
  error,
  onCancel,
  onCreate,
}: ApiKeyCreateFormProps) {
  const nameId = useId()
  const droppedNoteId = useId()
  const hasDroppedScopes = draft.droppedScopes.length > 0
  const input = createInputFromDraft(draft)

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={nameId} className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {nameLabel}
        </Label>
        <Input
          id={nameId}
          ref={nameInputRef}
          placeholder={namePlaceholder}
          value={draft.name}
          onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
          aria-describedby={hasDroppedScopes ? droppedNoteId : undefined}
          autoFocus
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Permissions</Label>
        <div className="rounded-md border divide-y">
          {API_KEY_ELIGIBLE_PICKER_SCOPES.map((perm) => (
            <label
              key={perm.slug}
              className="block px-3 py-2.5 cursor-pointer hover:bg-accent/50 transition-colors first:rounded-t-md last:rounded-b-md"
            >
              <span className="flex items-center gap-3">
                <Checkbox
                  checked={draft.scopes.has(perm.slug)}
                  onCheckedChange={() => onDraftChange(toggleDraftScope(draft, perm.slug))}
                />
                <span className="text-sm font-medium">{perm.name}</span>
              </span>
              <p className="text-xs text-muted-foreground leading-relaxed ml-7 mt-0.5">{perm.description}</p>
            </label>
          ))}
        </div>
        {hasDroppedScopes && (
          <p id={droppedNoteId} className="text-xs text-muted-foreground">
            Not copied, no longer available for keys:{" "}
            {draft.droppedScopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(", ")}
          </p>
        )}
      </div>

      <ApiKeyVersionControl
        apiVersion={draft.apiVersion === undefined ? CURRENT_API_VERSION : draft.apiVersion}
        onChange={(apiVersion) => onDraftChange({ ...draft, apiVersion })}
      />

      <Separator />

      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => input && onCreate(input)} disabled={!input || isPending}>
          {isPending ? "Creating..." : "Create key"}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error.message || "Failed to create key. Please try again."}</p>
      )}
    </div>
  )
}
