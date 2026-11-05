import { useEffect, useId, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { StreamTypes, type IncomingWebhook, type WorkspaceBootstrap } from "@threahq/types"
import { botsApi } from "@/api/bots"
import { API_BASE } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
import { Check, CircleAlert, Copy, Hash } from "lucide-react"
import {
  SETTING_CONTROL_HEIGHT,
  SettingAddButton,
  SettingEmptyNote,
  SettingNotice,
  SettingRemoveButton,
  SettingRow,
  SettingStateAction,
  SETTING_ITEM_DIVIDERS,
} from "@/components/settings/setting-primitives"
import { SETTING_ICON_BUTTON, SETTING_MUTED_NOTE_TEXT, SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { cn } from "@/lib/utils"
import { SECRET_FRAME } from "./new-api-key-notice"
import { RevokedList } from "./api-keys-panel"

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

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      toast.error("Could not copy to clipboard.")
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("w-12 shrink-0", SETTING_MUTED_NOTE_TEXT)}>{name}</span>
      <code className={cn("min-w-0 flex-1 truncate font-mono text-xs select-all", SECRET_FRAME)}>{value}</code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" className={SETTING_ICON_BUTTON} aria-label={label} onClick={copy}>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
      </Tooltip>
    </div>
  )
}

type TargetStream = WorkspaceBootstrap["streams"][number]

interface WebhookFormProps {
  streams: TargetStream[]
  initialName: string
  initialStreamId: string | null
  /** The saved target when it can no longer be picked (archived, encrypted): shown in its place, kept on save. */
  unselectableStreamName?: string
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
  unselectableStreamName,
  submitLabel,
  pendingLabel,
  isPending,
  onCancel,
  onSubmit,
}: WebhookFormProps) {
  const nameId = useId()
  const streamLabelId = useId()
  const [name, setName] = useState(initialName)
  const [streamId, setStreamId] = useState<string | null>(initialStreamId)
  const selectedStream = useMemo(() => streams.find((s) => s.id === streamId) ?? null, [streams, streamId])

  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          placeholder="e.g. alertmanager"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={SETTING_CONTROL_HEIGHT}
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <Label id={streamLabelId}>Posts to</Label>
        <SearchableSelect
          items={streams}
          value={selectedStream}
          onChange={(stream) => setStreamId(stream.id)}
          getKey={(s) => s.id}
          getKeywords={(s) => [streamLabel(s), s.slug ?? "", s.displayName ?? ""].filter(Boolean)}
          placeholder={unselectableStreamName ?? "Select a stream"}
          searchPlaceholder="Search streams"
          emptyMessage="No matching streams"
          triggerIcon={Hash}
          aria-labelledby={streamLabelId}
          className={SETTING_CONTROL_HEIGHT}
          renderItem={(stream) => <span className="truncate text-sm">{streamLabel(stream)}</span>}
          renderSelected={(stream) => <span className="truncate text-sm">{streamLabel(stream)}</span>}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" className={SETTING_CONTROL_HEIGHT} onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          className={SETTING_CONTROL_HEIGHT}
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
    <SettingRow
      label="Webhooks"
      description={
        <>
          Let another service post into a stream.{" "}
          <a
            href={WEBHOOK_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Docs
          </a>
        </>
      }
      control={
        !isArchived && !showForm && <SettingAddButton onClick={() => setShowForm(true)}>New webhook</SettingAddButton>
      }
    >
      <div className="space-y-3">
        {createdUrls && (
          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium">Your new webhook URL</p>
              <SettingNotice icon={CircleAlert}>
                Copy it now. It won&apos;t be shown again. Tools that expect a Slack webhook take the Slack URL.
              </SettingNotice>
            </div>
            <WebhookUrlRow name="Native" label="Copy webhook URL" value={createdUrls.url} />
            <WebhookUrlRow name="Slack" label="Copy Slack webhook URL" value={createdUrls.slackUrl} />
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" className={SETTING_CONTROL_HEIGHT} onClick={dismissCreated}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {showForm && (
          <WebhookForm
            streams={targetStreams}
            initialName=""
            initialStreamId={null}
            submitLabel="Create webhook"
            pendingLabel="Creating…"
            isPending={createMutation.isPending}
            onCancel={() => setShowForm(false)}
            onSubmit={(values) => createMutation.mutate(values)}
          />
        )}

        {isLoading && <Skeleton className="h-11 w-full" />}

        {isError && (
          <SettingStateAction live action={{ children: "Retry", onClick: () => void refetch() }}>
            Couldn&apos;t load webhooks.
          </SettingStateAction>
        )}

        {!isLoading && activeWebhooks.length > 0 && (
          <ul className={SETTING_ITEM_DIVIDERS}>
            {activeWebhooks.map((hook: IncomingWebhook) =>
              editingHookId === hook.id ? (
                <li key={hook.id}>
                  <WebhookForm
                    streams={targetStreams}
                    initialName={hook.name}
                    initialStreamId={hook.streamId}
                    unselectableStreamName={
                      targetStreams.some((s) => s.id === hook.streamId) ? undefined : streamNameFor(hook.streamId)
                    }
                    submitLabel="Save webhook"
                    pendingLabel="Saving…"
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
                </li>
              ) : (
                <li key={hook.id} className="flex min-h-11 items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="truncate text-sm font-medium">{hook.name}</span>
                      <span className={cn("truncate", SETTING_MUTED_NOTE_TEXT)}>{streamNameFor(hook.streamId)}</span>
                    </div>
                    <p className={cn("mt-0.5", SETTING_MUTED_NOTE_TEXT)}>
                      Created {formatDate(new Date(hook.createdAt))}
                      {hook.lastUsedAt && ` · Last used ${formatDate(new Date(hook.lastUsedAt))}`}
                    </p>
                  </div>
                  {!isArchived && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className={SETTING_CONTROL_HEIGHT}
                        aria-label={`Edit ${hook.name}`}
                        onClick={() => setEditingHookId(hook.id)}
                      >
                        Edit
                      </Button>
                      <SettingRemoveButton
                        label={`Revoke ${hook.name}`}
                        onClick={() => setRevokeTarget({ id: hook.id, name: hook.name })}
                      />
                    </div>
                  )}
                </li>
              )
            )}
          </ul>
        )}

        {!isLoading && !isError && activeWebhooks.length === 0 && !showForm && (
          <SettingEmptyNote>No webhooks yet.</SettingEmptyNote>
        )}

        <RevokedList
          noun="webhook"
          items={revokedWebhooks.map((hook) => ({
            id: hook.id,
            name: hook.name,
            detail: <span className={cn("truncate", SETTING_NOTE_TEXT)}>{streamNameFor(hook.streamId)}</span>,
          }))}
        />
      </div>

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
              {revokeMutation.isPending ? "Revoking…" : "Revoke webhook"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingRow>
  )
}
