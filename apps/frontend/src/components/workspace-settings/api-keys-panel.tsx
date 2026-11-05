import { useId, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query"
import { MoreHorizontal } from "lucide-react"
import type { CreateApiKeyInput, UserApiKey, WorkspacePermissionSlug } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import {
  SettingAddButton,
  SettingEmptyNote,
  SettingFieldError,
  SettingsDisclosureTrigger,
  SettingBadge,
} from "@/components/settings/setting-primitives"
import { SettingCheckboxList } from "@/components/settings/setting-lists"
import { SETTING_ICON_BUTTON, SETTING_MUTED_NOTE_TEXT, SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { cn } from "@/lib/utils"
import { ApiKeyVersionControl } from "./api-key-version-control"
import { NewApiKeyNotice } from "./new-api-key-notice"
import {
  API_KEY_SCOPE_ITEMS,
  ApiKeyCreateDialog,
  NEW_API_KEY_DRAFT,
  SCOPE_LABELS,
  draftFromKey,
  useApiKeyCreateForm,
} from "./api-key-create-form"

type ApiKey = Pick<
  UserApiKey,
  "id" | "name" | "keyPrefix" | "scopes" | "apiVersion" | "lastUsedAt" | "revokedAt" | "createdAt"
>

/** Where one owner's keys live: personal keys or a bot's. */
interface ApiKeysSource {
  queryKey: QueryKey
  /** Shown before each key's prefix, such as `threa_uk_`. */
  secretPrefix: string
  list: () => Promise<ApiKey[]>
  create: (input: CreateApiKeyInput) => Promise<{ key: { name: string }; value: string }>
  updateScopes: (keyId: string, scopes: WorkspacePermissionSlug[]) => Promise<unknown>
  updateVersion: (keyId: string, apiVersion: string | null) => Promise<unknown>
  revoke: (keyId: string) => Promise<unknown>
}

/**
 * A key owner's list: the new-key secret, active keys with a ⋯ menu each,
 * revoked keys behind a disclosure, and the create, permissions and revoke
 * dialogs. `children` places the New key button and the list in a row.
 */
export function ApiKeysPanel({
  source,
  readOnly = false,
  nameLabel,
  namePlaceholder,
  children,
}: {
  source: ApiKeysSource
  /** An archived owner: no new or duplicated keys. */
  readOnly?: boolean
  nameLabel: string
  namePlaceholder: string
  children: (slots: { newKeyButton: ReactNode; list: ReactNode }) => ReactNode
}) {
  const queryClient = useQueryClient()
  const { formatDate } = useFormattedDate()
  const { data: keys = [], isLoading } = useQuery({ queryKey: source.queryKey, queryFn: source.list })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: source.queryKey })

  const [createdKey, setCreatedKey] = useState<{ name: string; value: string } | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null)
  const [scopesTarget, setScopesTarget] = useState<ApiKey | null>(null)

  const createForm = useApiKeyCreateForm({
    create: source.create,
    onCreated: (created) => {
      setCreatedKey({ name: created.key.name, value: created.value })
      invalidate()
    },
  })

  const updateVersionMutation = useMutation({
    mutationFn: (params: { keyId: string; apiVersion: string | null }) =>
      source.updateVersion(params.keyId, params.apiVersion),
    onSuccess: invalidate,
  })

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => source.revoke(keyId),
    onSuccess: () => {
      setRevokeTarget(null)
      invalidate()
    },
    onError: () => setRevokeTarget(null),
  })

  const activeKeys = keys.filter((k) => !k.revokedAt)
  const revokedKeys = keys.filter((k) => k.revokedAt)

  const newKeyButton = !isLoading && !readOnly && (
    <SettingAddButton onClick={() => createForm.open(NEW_API_KEY_DRAFT)}>New key</SettingAddButton>
  )

  const list = isLoading ? (
    <div className="space-y-2" aria-hidden>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  ) : (
    <div className="space-y-3">
      {createdKey && (
        <NewApiKeyNotice name={createdKey.name} value={createdKey.value} onDismiss={() => setCreatedKey(null)} />
      )}

      {activeKeys.length > 0 ? (
        <ul className="divide-y divide-border">
          {activeKeys.map((key) => (
            <li key={key.id} className="flex min-h-11 items-start justify-between gap-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="truncate text-sm font-medium">{key.name}</span>
                  <code className={cn("font-mono", SETTING_MUTED_NOTE_TEXT)}>
                    {source.secretPrefix}
                    {key.keyPrefix}…
                  </code>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {key.scopes.map((scope) => (
                    <SettingBadge key={scope}>{SCOPE_LABELS[scope] ?? scope}</SettingBadge>
                  ))}
                </div>
                <p className={cn("mt-1", SETTING_MUTED_NOTE_TEXT)}>
                  Created {formatDate(new Date(key.createdAt))}
                  {key.lastUsedAt && ` · Last used ${formatDate(new Date(key.lastUsedAt))}`}
                </p>
                <ApiKeyVersionControl
                  apiVersion={key.apiVersion}
                  disabled={updateVersionMutation.isPending}
                  onChange={(apiVersion) => updateVersionMutation.mutate({ keyId: key.id, apiVersion })}
                />
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={SETTING_ICON_BUTTON}
                    aria-label={`Actions for ${key.name}`}
                  >
                    <MoreHorizontal aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {!readOnly && (
                    <DropdownMenuItem
                      disabled={createForm.isPending}
                      onSelect={() => createForm.open(draftFromKey(key))}
                    >
                      Duplicate
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => setScopesTarget(key)}>Edit permissions</DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setRevokeTarget(key)}
                  >
                    Revoke
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      ) : (
        <SettingEmptyNote>No API keys yet.</SettingEmptyNote>
      )}

      <RevokedList
        noun="key"
        items={revokedKeys.map((key) => ({
          id: key.id,
          name: key.name,
          detail: (
            <code className={cn("font-mono", SETTING_NOTE_TEXT)}>
              {source.secretPrefix}
              {key.keyPrefix}…
            </code>
          ),
        }))}
      />

      {updateVersionMutation.error && (
        <SettingFieldError>Couldn&apos;t change the API version. Try again.</SettingFieldError>
      )}
      {revokeMutation.error && <SettingFieldError>Couldn&apos;t revoke the key. Try again.</SettingFieldError>}

      <ApiKeyCreateDialog form={createForm.form} nameLabel={nameLabel} namePlaceholder={namePlaceholder} />

      <ApiKeyScopesDialog
        target={scopesTarget}
        onClose={() => setScopesTarget(null)}
        save={source.updateScopes}
        onSaved={invalidate}
      />

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently revoke <strong className="text-foreground">{revokeTarget?.name}</strong>. Any
              applications using this key will lose access immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revokeMutation.isPending ? "Revoking…" : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )

  return <>{children({ newKeyButton, list })}</>
}

/** Revoked keys or webhooks, collapsed under a count. */
export function RevokedList({
  noun,
  items,
}: {
  noun: string
  items: { id: string; name: string; detail: ReactNode }[]
}) {
  if (items.length === 0) return null
  return (
    <Collapsible>
      <SettingsDisclosureTrigger
        className="-mx-4 w-[calc(100%+2rem)] rounded-none"
        heading={
          <span className="text-sm font-medium">
            {items.length} revoked {noun}
            {items.length > 1 ? "s" : ""}
          </span>
        }
      />
      <CollapsibleContent>
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex min-h-11 items-center gap-2 py-2 text-muted-foreground">
              <span className="truncate text-sm line-through">{item.name}</span>
              {item.detail}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ApiKeyScopesDialog({
  target,
  onClose,
  save,
  onSaved,
}: {
  target: ApiKey | null
  onClose: () => void
  save: (keyId: string, scopes: WorkspacePermissionSlug[]) => Promise<unknown>
  onSaved: () => void
}) {
  return (
    <ResponsiveDialog open={target !== null} onOpenChange={(open) => !open && onClose()} historyEntry={false}>
      <ResponsiveDialogContent desktopClassName="max-w-md" drawerClassName="max-h-[92dvh]">
        {target && <ApiKeyScopesForm key={target.id} target={target} onClose={onClose} save={save} onSaved={onSaved} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function ApiKeyScopesForm({
  target,
  onClose,
  save,
  onSaved,
}: {
  target: ApiKey
  onClose: () => void
  save: (keyId: string, scopes: WorkspacePermissionSlug[]) => Promise<unknown>
  onSaved: () => void
}) {
  const listId = useId()
  const [scopes, setScopes] = useState<Set<WorkspacePermissionSlug>>(() => new Set(target.scopes))
  const mutation = useMutation({
    mutationFn: () => save(target.id, [...scopes]),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })

  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Edit permissions</ResponsiveDialogTitle>
        <ResponsiveDialogDescription id={listId}>{target.name}</ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
      <ResponsiveDialogBody className="min-h-0 space-y-3">
        <SettingCheckboxList
          aria-labelledby={listId}
          items={API_KEY_SCOPE_ITEMS}
          selected={scopes}
          disabled={mutation.isPending}
          onCheckedChange={(scope, checked) =>
            setScopes((prev) => {
              const next = new Set(prev)
              if (checked) next.add(scope)
              else next.delete(scope)
              return next
            })
          }
        />
        {mutation.error && <SettingFieldError>Couldn&apos;t save the permissions. Try again.</SettingFieldError>}
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button onClick={() => mutation.mutate()} disabled={scopes.size === 0 || mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save permissions"}
        </Button>
      </ResponsiveDialogFooter>
    </>
  )
}
