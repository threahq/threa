import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { StreamTypes, type IncomingWebhook } from "@threahq/types"
import { botsApi } from "@/api/bots"
import { API_BASE } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { SearchableSelect } from "@/components/ui/searchable-select"
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
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { resolveStreamName, streamLabel } from "@/lib/streams"
import { buildIncomingWebhookUrls } from "@/lib/webhook-url"
import { Check, ChevronDown, Copy, Hash, Pencil, Plus, Trash2, Webhook } from "lucide-react"

const WEBHOOK_DOCS_URL = "https://threa.io/developers/incoming-webhooks"

interface BotWebhooksSectionProps {
  workspaceId: string
  botId: string
  isArchived: boolean
}

interface WebhookUrlRowProps {
  name: string
  label: string
  value: string
}

function WebhookUrlRow({ name, label, value }: WebhookUrlRowProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Could not copy to clipboard.")
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-12 shrink-0 text-xs text-muted-foreground">{name}</span>
      <code className="flex-1 min-w-0 truncate text-xs bg-background border p-2.5 rounded-md font-mono select-all">
        {value}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" className="shrink-0 h-9 w-9" aria-label={label} onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied!" : label}</TooltipContent>
      </Tooltip>
    </div>
  )
}

type TargetStream = NonNullable<ReturnType<typeof useCachedWorkspaceBootstrap>>["streams"][number]

interface WebhookFormProps {
  streams: TargetStream[]
  initialName: string
  initialStreamId: string | null
  submitLabel: string
  pendingLabel: string
  isPending: boolean
  onCancel: () => void
  onSubmit: (values: { name: string; streamId: string }) => void
}

function WebhookForm({
  streams,
  initialName,
  initialStreamId,
  submitLabel,
  pendingLabel,
  isPending,
  onCancel,
  onSubmit,
}: WebhookFormProps) {
  const [name, setName] = useState(initialName)
  const [streamId, setStreamId] = useState<string | null>(initialStreamId)
  const selectedStream = useMemo(() => streams.find((s) => s.id === streamId) ?? null, [streams, streamId])

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Webhook name</Label>
        <Input placeholder="e.g. alertmanager" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Posts to</Label>
        <SearchableSelect
          items={streams}
          value={selectedStream}
          onChange={(stream) => setStreamId(stream.id)}
          getKey={(s) => s.id}
          getKeywords={(s) => [streamLabel(s), s.slug ?? "", s.displayName ?? ""].filter(Boolean)}
          placeholder="Select a stream..."
          searchPlaceholder="Search streams..."
          emptyMessage="No matching streams"
          triggerIcon={Hash}
          renderItem={(stream) => <span className="text-sm truncate">{streamLabel(stream)}</span>}
          renderSelected={(stream) => <span className="text-sm truncate">{streamLabel(stream)}</span>}
        />
      </div>
      <Separator />
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => streamId && onSubmit({ name: name.trim(), streamId })}
          disabled={!name.trim() || !streamId || isPending}
        >
          {isPending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </div>
  )
}

export function BotWebhooksSection({ workspaceId, botId, isArchived }: BotWebhooksSectionProps) {
  const queryClient = useQueryClient()
  const webhooksQueryKey = ["bot-webhooks", workspaceId, botId]
  const { formatDate } = useFormattedDate()
  const wsBootstrap = useCachedWorkspaceBootstrap(workspaceId)

  const {
    data: webhooks = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: webhooksQueryKey,
    queryFn: () => botsApi.listWebhooks(workspaceId, botId),
  })

  const [showForm, setShowForm] = useState(false)
  const [editingHookId, setEditingHookId] = useState<string | null>(null)
  const [created, setCreated] = useState<{ hookId: string; secret: string } | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null)
  const [revokedOpen, setRevokedOpen] = useState(false)

  const targetStreams = useMemo(() => {
    if (!wsBootstrap?.streams) return []
    return wsBootstrap.streams
      .filter(
        (s) => (s.type === StreamTypes.CHANNEL || s.type === StreamTypes.SCRATCHPAD) && !s.archivedAt && !s.e2eEnabled
      )
      .sort((a, b) => streamLabel(a).localeCompare(streamLabel(b)))
  }, [wsBootstrap])

  // Webhooks only ever target channels and scratchpads, so DM peer resolution has nothing to do.
  const streamNameFor = (id: string) =>
    resolveStreamName(id, { streams: wsBootstrap?.streams ?? [], users: [], dmPeers: [] }) ?? id

  const createMutation = useMutation({
    mutationFn: (values: { name: string; streamId: string }) => botsApi.createWebhook(workspaceId, botId, values),
    onSuccess: (data) => {
      setCreated({ hookId: data.webhook.id, secret: data.secret })
      setShowForm(false)
      queryClient.invalidateQueries({ queryKey: webhooksQueryKey })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not create the webhook."),
  })

  const updateMutation = useMutation({
    mutationFn: ({ hookId, ...changes }: { hookId: string; name?: string; streamId?: string }) =>
      botsApi.updateWebhook(workspaceId, botId, hookId, changes),
    onSuccess: () => {
      setEditingHookId(null)
      queryClient.invalidateQueries({ queryKey: webhooksQueryKey })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update the webhook."),
  })

  const revokeMutation = useMutation({
    mutationFn: (hookId: string) => botsApi.revokeWebhook(workspaceId, botId, hookId),
    onSuccess: () => {
      setRevokeTarget(null)
      queryClient.invalidateQueries({ queryKey: webhooksQueryKey })
    },
    onError: (error) => {
      setRevokeTarget(null)
      toast.error(error instanceof Error ? error.message : "Could not revoke the webhook.")
    },
  })

  const resetCreateMutation = createMutation.reset
  useEffect(() => resetCreateMutation, [resetCreateMutation])

  const dismissCreated = () => {
    setCreated(null)
    resetCreateMutation()
  }

  const activeWebhooks = webhooks.filter((h) => !h.revokedAt)
  const revokedWebhooks = webhooks.filter((h) => h.revokedAt)
  const createdUrls = created
    ? buildIncomingWebhookUrls(API_BASE || window.location.origin, workspaceId, created.hookId, created.secret)
    : null

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Webhooks</h4>
          <a
            href={WEBHOOK_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Docs
          </a>
        </div>
        {!isArchived && !showForm && (
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowForm(true)}>
            <Plus className="h-3 w-3 mr-1" />
            New webhook
          </Button>
        )}
      </div>

      {createdUrls && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <Webhook className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Your new webhook URL</p>
              <p className="text-xs text-muted-foreground">
                Copy it now. For security, it won&apos;t be displayed again. Tools that expect a Slack webhook take the
                Slack URL.
              </p>
            </div>
          </div>
          <WebhookUrlRow name="Native" label="Copy webhook URL" value={createdUrls.url} />
          <WebhookUrlRow name="Slack" label="Copy Slack webhook URL" value={createdUrls.slackUrl} />
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={dismissCreated}>
            Dismiss
          </Button>
        </div>
      )}

      {showForm && (
        <WebhookForm
          streams={targetStreams}
          initialName=""
          initialStreamId={null}
          submitLabel="Create webhook"
          pendingLabel="Creating..."
          isPending={createMutation.isPending}
          onCancel={() => setShowForm(false)}
          onSubmit={(values) => createMutation.mutate(values)}
        />
      )}

      {isLoading && <Skeleton className="h-16 w-full" />}

      {!isLoading && activeWebhooks.length > 0 && (
        <div className="rounded-lg border divide-y">
          {activeWebhooks.map((hook: IncomingWebhook) =>
            editingHookId === hook.id ? (
              <WebhookForm
                key={hook.id}
                streams={targetStreams}
                initialName={hook.name}
                initialStreamId={hook.streamId}
                submitLabel="Save webhook"
                pendingLabel="Saving..."
                isPending={updateMutation.isPending}
                onCancel={() => setEditingHookId(null)}
                onSubmit={(values) => {
                  const changes = {
                    ...(values.name !== hook.name && { name: values.name }),
                    ...(values.streamId !== hook.streamId && { streamId: values.streamId }),
                  }
                  if (Object.keys(changes).length === 0) setEditingHookId(null)
                  else updateMutation.mutate({ hookId: hook.id, ...changes })
                }}
              />
            ) : (
              <div key={hook.id} className="flex items-center gap-3 px-3 py-3 group reveal-host">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">{hook.name}</span>
                    <span className="text-[11px] text-muted-foreground truncate">{streamNameFor(hook.streamId)}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Created {formatDate(new Date(hook.createdAt))}
                    {hook.lastUsedAt && (
                      <>
                        <span className="mx-1 text-border">&middot;</span>
                        Last used {formatDate(new Date(hook.lastUsedAt))}
                      </>
                    )}
                  </p>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="reveal-actions shrink-0 h-8 w-8"
                      aria-label={`Edit ${hook.name}`}
                      onClick={() => setEditingHookId(hook.id)}
                    >
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit webhook</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="reveal-actions shrink-0 h-8 w-8"
                      aria-label={`Revoke ${hook.name}`}
                      onClick={() => setRevokeTarget({ id: hook.id, name: hook.name })}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive transition-colors" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Revoke webhook</TooltipContent>
                </Tooltip>
              </div>
            )
          )}
        </div>
      )}

      {isError && (
        <p className="text-xs text-muted-foreground">
          Couldn&apos;t load webhooks.{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}

      {!isLoading && !isError && activeWebhooks.length === 0 && !showForm && (
        <div className="rounded-lg border border-dashed py-6 flex flex-col items-center gap-2">
          <Webhook className="h-4 w-4 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">No webhooks yet. Create one to post into a stream.</p>
        </div>
      )}

      {revokedWebhooks.length > 0 && (
        <Collapsible open={revokedOpen} onOpenChange={setRevokedOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer py-1 group">
            <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
            {revokedWebhooks.length} revoked webhook{revokedWebhooks.length > 1 ? "s" : ""}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 space-y-1">
              {revokedWebhooks.map((hook: IncomingWebhook) => (
                <div key={hook.id} className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground/50">
                  <span className="text-sm line-through truncate">{hook.name}</span>
                  <span className="text-[10px] truncate">{streamNameFor(hook.streamId)}</span>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke webhook</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently revoke <strong className="text-foreground">{revokeTarget?.name}</strong>. Anything
              posting to this URL will stop working immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revokeMutation.isPending ? "Revoking..." : "Revoke webhook"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
