import { useCallback, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { workspacesApi } from "@/api/workspaces"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
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
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { API_KEY_ELIGIBLE_PICKER_SCOPES, WORKSPACE_PERMISSIONS, type WorkspacePermissionSlug } from "@threa/types"
import { Check, ChevronDown, Copy, Key, Plus, Trash2, Eye, EyeOff } from "lucide-react"

// Full catalog drives SCOPE_LABELS so previously-issued keys with scopes
// outside the eligible picker subset still render a human-readable name.
const SCOPE_LABELS: Record<string, string> = Object.fromEntries(WORKSPACE_PERMISSIONS.map((p) => [p.slug, p.name]))

interface UserApiKeysSectionProps {
  workspaceId: string
}

export function UserApiKeysSection({ workspaceId }: UserApiKeysSectionProps) {
  const queryClient = useQueryClient()
  const queryKey = ["user-api-keys", workspaceId]
  const { formatDate } = useFormattedDate()

  const { data: keys = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => workspacesApi.listUserApiKeys(workspaceId),
  })

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [selectedScopes, setSelectedScopes] = useState<Set<WorkspacePermissionSlug>>(new Set())
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null)
  const [showKeyValue, setShowKeyValue] = useState(false)
  const [copied, setCopied] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null)
  const [editTarget, setEditTarget] = useState<{ id: string; name: string } | null>(null)
  const [editScopes, setEditScopes] = useState<Set<WorkspacePermissionSlug>>(new Set())
  const [revokedOpen, setRevokedOpen] = useState(false)

  const createMutation = useMutation({
    mutationFn: (params: { name: string; scopes: WorkspacePermissionSlug[] }) =>
      workspacesApi.createUserApiKey(workspaceId, params),
    onSuccess: (data) => {
      setCreatedKeyValue(data.value)
      setShowKeyValue(true)
      setCopied(false)
      setNewKeyName("")
      setSelectedScopes(new Set())
      setShowCreateForm(false)
      queryClient.invalidateQueries({ queryKey })
    },
  })

  const updateScopesMutation = useMutation({
    mutationFn: (params: { keyId: string; scopes: WorkspacePermissionSlug[] }) =>
      workspacesApi.updateUserApiKeyScopes(workspaceId, params.keyId, params.scopes),
    onSuccess: () => {
      setEditTarget(null)
      setEditScopes(new Set())
      queryClient.invalidateQueries({ queryKey })
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => workspacesApi.revokeUserApiKey(workspaceId, keyId),
    onSuccess: () => {
      setRevokeTarget(null)
      queryClient.invalidateQueries({ queryKey })
    },
    onError: () => {
      setRevokeTarget(null)
    },
  })

  const toggleScope = (scope: WorkspacePermissionSlug) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) {
        next.delete(scope)
      } else {
        next.add(scope)
      }
      return next
    })
  }

  const handleCreate = () => {
    if (!newKeyName.trim() || selectedScopes.size === 0) return
    createMutation.mutate({ name: newKeyName.trim(), scopes: [...selectedScopes] })
  }

  const startEditingScopes = (key: { id: string; name: string; scopes: WorkspacePermissionSlug[] }) => {
    setEditTarget({ id: key.id, name: key.name })
    setEditScopes(new Set(key.scopes))
  }

  const toggleEditScope = (scope: WorkspacePermissionSlug) => {
    setEditScopes((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      return next
    })
  }

  const handleUpdateScopes = () => {
    if (!editTarget || editScopes.size === 0) return
    updateScopesMutation.mutate({ keyId: editTarget.id, scopes: [...editScopes] })
  }

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable
    }
  }, [])

  const activeKeys = keys.filter((k) => !k.revokedAt)
  const revokedKeys = keys.filter((k) => k.revokedAt)

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Key reveal banner ── */}
      {createdKeyValue && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <Key className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Your new API key</p>
              <p className="text-xs text-muted-foreground">
                Copy this key now. For security, it won't be displayed again.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <code className="flex-1 text-xs bg-background border p-2.5 rounded-md break-all font-mono select-all">
              {showKeyValue ? createdKeyValue : "••••••••••••••••••••••••••••••••••••••••"}
            </code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0 h-9 w-9"
                  onClick={() => setShowKeyValue(!showKeyValue)}
                >
                  {showKeyValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showKeyValue ? "Hide" : "Reveal"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0 h-9 w-9"
                  onClick={() => copyToClipboard(createdKeyValue)}
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{copied ? "Copied!" : "Copy to clipboard"}</TooltipContent>
            </Tooltip>
          </div>

          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setCreatedKeyValue(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Personal keys act on your behalf with the same stream access as your account.
        </p>
        {!showCreateForm && (
          <Button variant="outline" size="sm" className="shrink-0 ml-4" onClick={() => setShowCreateForm(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New key
          </Button>
        )}
      </div>

      {/* ── Create form ── */}
      {showCreateForm && (
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="key-name" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Name
            </Label>
            <Input
              id="key-name"
              placeholder="e.g. CI pipeline, local dev script"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
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
                    <Checkbox checked={selectedScopes.has(perm.slug)} onCheckedChange={() => toggleScope(perm.slug)} />
                    <span className="text-sm font-medium">{perm.name}</span>
                  </span>
                  <p className="text-xs text-muted-foreground leading-relaxed ml-7 mt-0.5">{perm.description}</p>
                </label>
              ))}
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowCreateForm(false)
                setNewKeyName("")
                setSelectedScopes(new Set())
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!newKeyName.trim() || selectedScopes.size === 0 || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating..." : "Create key"}
            </Button>
          </div>

          {createMutation.error && (
            <p className="text-sm text-destructive">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Failed to create key. Please try again."}
            </p>
          )}
        </div>
      )}

      {/* ── Active keys list ── */}
      {activeKeys.length > 0 && (
        <div className="rounded-lg border divide-y">
          {activeKeys.map((key) => (
            <div key={key.id} className="flex items-center gap-3 px-3 py-3 group">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium truncate">{key.name}</span>
                  <code className="text-[11px] text-muted-foreground/70 font-mono hidden sm:inline">
                    threa_uk_{key.keyPrefix}...
                  </code>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {key.scopes.map((scope) => (
                    <Badge key={scope} variant="secondary" className="text-[10px] px-1.5 py-0 h-5 font-normal">
                      {SCOPE_LABELS[scope] ?? scope}
                    </Badge>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  Created {formatDate(new Date(key.createdAt))}
                  {key.lastUsedAt && (
                    <>
                      <span className="mx-1 text-border">·</span>
                      Last used {formatDate(new Date(key.lastUsedAt))}
                    </>
                  )}
                </p>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 h-8 w-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                    onClick={() => startEditingScopes(key)}
                  >
                    <Key className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit scopes</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 h-8 w-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                    onClick={() => setRevokeTarget({ id: key.id, name: key.name })}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive transition-colors" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Revoke key</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {activeKeys.length === 0 && !showCreateForm && (
        <div className="rounded-lg border border-dashed py-8 flex flex-col items-center gap-2">
          <Key className="h-5 w-5 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No API keys yet</p>
        </div>
      )}

      {/* ── Revoked keys ── */}
      {revokedKeys.length > 0 && (
        <Collapsible open={revokedOpen} onOpenChange={setRevokedOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer py-1 group">
            <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
            {revokedKeys.length} revoked key{revokedKeys.length > 1 ? "s" : ""}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 space-y-1">
              {revokedKeys.map((key) => (
                <div key={key.id} className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground/50">
                  <span className="text-sm line-through truncate">{key.name}</span>
                  <code className="text-[10px] font-mono">threa_uk_{key.keyPrefix}...</code>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* ── Key update errors ── */}
      {updateScopesMutation.error && (
        <p className="text-sm text-destructive">Failed to update key scopes. Please try again.</p>
      )}
      {revokeMutation.error && <p className="text-sm text-destructive">Failed to revoke key. Please try again.</p>}

      {/* ── Edit scopes dialog ── */}
      <AlertDialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Edit API key scopes</AlertDialogTitle>
            <AlertDialogDescription>
              Update permissions for <strong className="text-foreground">{editTarget?.name}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-80 overflow-auto rounded-md border divide-y">
            {API_KEY_ELIGIBLE_PICKER_SCOPES.map((perm) => (
              <label key={perm.slug} className="block px-3 py-2.5 cursor-pointer hover:bg-accent/50">
                <span className="flex items-center gap-3">
                  <Checkbox checked={editScopes.has(perm.slug)} onCheckedChange={() => toggleEditScope(perm.slug)} />
                  <span className="text-sm font-medium">{perm.name}</span>
                </span>
                <p className="text-xs text-muted-foreground leading-relaxed ml-7 mt-0.5">{perm.description}</p>
              </label>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleUpdateScopes} disabled={editScopes.size === 0}>
              {updateScopesMutation.isPending ? "Saving..." : "Save scopes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Revoke confirmation dialog ── */}
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
              {revokeMutation.isPending ? "Revoking..." : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
