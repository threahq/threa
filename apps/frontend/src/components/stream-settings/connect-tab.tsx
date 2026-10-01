import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Building2, Check, Copy, Link as LinkIcon } from "lucide-react"
import { StreamConnectionErrorCodes, StreamConnectionStates, type Stream, type StreamConnection } from "@threahq/types"
import { ApiError } from "@/api/client"
import { streamConnectionInviteUrl, streamConnectionsApi } from "@/api/stream-connections"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { usePreferences } from "@/contexts"
import { formatFutureTime, formatTime, type TimePrefs } from "@/lib/dates"

const COPY_CONFIRMATION_MS = 2_000
/** Picks up the partner's accept while the host has the tab open. */
const PENDING_INVITE_POLL_MS = 15_000
const HOUR_MS = 60 * 60_000

function connectionsKey(workspaceId: string, streamId: string) {
  return ["stream-connections", workspaceId, streamId] as const
}

function errorMessage(error: unknown, fallback: string): string {
  if (!ApiError.isApiError(error)) return fallback
  switch (error.code) {
    case StreamConnectionErrorCodes.NOT_SHAREABLE:
      return "Only active, unencrypted channels can be shared."
    default:
      return fallback
  }
}

/** The list moved on under us (another admin shared, or the partner accepted): show the new state, not an error. */
function isStaleState(error: unknown): boolean {
  return (
    ApiError.isApiError(error) &&
    (error.code === StreamConnectionErrorCodes.ALREADY_SHARED ||
      error.code === StreamConnectionErrorCodes.ALREADY_ACCEPTED)
  )
}

function isPendingInvite(connection: StreamConnection | undefined): boolean {
  return connection?.state === StreamConnectionStates.INVITED && new Date(connection.expiresAt).getTime() > Date.now()
}

/** formatFutureTime counts down minutes inside the last hour, which an open tab would leave stale. */
function expiryTime(expiresAt: Date, prefs: TimePrefs): string {
  if (expiresAt.getTime() - Date.now() < HOUR_MS) return formatTime(expiresAt, prefs)
  return formatFutureTime(expiresAt, new Date(), prefs)
}

function unshareableReason(stream: Stream): string | null {
  if (stream.archivedAt) return "Archived channels can't be shared."
  if (stream.e2eEnabled) return "Encrypted channels can't be shared."
  return null
}

interface ConnectTabProps {
  workspaceId: string
  stream: Stream
}

export function ConnectTab({ workspaceId, stream }: ConnectTabProps) {
  const queryClient = useQueryClient()
  const queryKey = connectionsKey(workspaceId, stream.id)
  const { preferences } = usePreferences()
  // The plaintext link exists only in the create response, so it lives here
  // until the tab closes.
  const [created, setCreated] = useState<{ connectionId: string; url: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const connectionsQuery = useQuery({
    queryKey,
    queryFn: () => streamConnectionsApi.list(workspaceId, stream.id),
    refetchInterval: (query) => (isPendingInvite(query.state.data?.[0]) ? PENDING_INVITE_POLL_MS : false),
  })

  const create = useMutation({
    mutationFn: () => streamConnectionsApi.createInvite(workspaceId, stream.id),
    onMutate: () => setActionError(null),
    onSuccess: async ({ connection, token }) => {
      // A poll still in flight would land the pre-create list and hide the only copy of the link.
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData<StreamConnection[]>(queryKey, [connection])
      setCreated({ connectionId: connection.id, url: streamConnectionInviteUrl(token) })
    },
    onError: (error) => {
      if (isStaleState(error)) void queryClient.invalidateQueries({ queryKey })
      else setActionError(errorMessage(error, "Couldn't create the link. Try again."))
    },
  })

  const revoke = useMutation({
    mutationFn: (connectionId: string) => streamConnectionsApi.revoke(workspaceId, connectionId),
    onMutate: () => setActionError(null),
    onSuccess: async (connection) => {
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData<StreamConnection[]>(queryKey, (current) =>
        (current ?? []).filter((c) => c.id !== connection.id)
      )
      setCreated(null)
    },
    onError: (error) => {
      if (isStaleState(error)) void queryClient.invalidateQueries({ queryKey })
      else setActionError(errorMessage(error, "Couldn't revoke the link. Try again."))
    },
  })

  if (connectionsQuery.isPending) {
    return (
      <div className="space-y-3 p-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  // A failed background refetch keeps showing the last list it loaded.
  const connections = connectionsQuery.data
  if (connections === undefined) {
    return (
      <div className="space-y-3 p-1">
        <p role="alert" className="text-sm text-destructive">
          Couldn't load this channel's connections.
        </p>
        <Button variant="outline" size="sm" onClick={() => void connectionsQuery.refetch()}>
          Try again
        </Button>
      </div>
    )
  }

  const live = connections[0] ?? null
  const busy = create.isPending || revoke.isPending

  if (live?.state === StreamConnectionStates.ACTIVE) {
    return (
      <div className="space-y-3 p-1">
        <Label className="text-sm font-medium">Shared with</Label>
        <div className="flex items-center gap-3 rounded-lg border px-3 py-3">
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">{live.remoteWorkspaceName}</span>
        </div>
      </div>
    )
  }

  const blocked = unshareableReason(stream)
  if (!live) {
    return (
      <div className="space-y-3 p-1">
        <Label className="text-sm font-medium">Share with another workspace</Label>
        <p className="text-sm text-muted-foreground">
          {blocked ?? "Any admin of another workspace who opens the link can accept it."}
        </p>
        {!blocked && (
          <Button onClick={() => create.mutate()} disabled={busy}>
            <LinkIcon className="mr-2 h-4 w-4" />
            {create.isPending ? "Creating…" : "Create invite link"}
          </Button>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
      </div>
    )
  }

  const expiresAt = new Date(live.expiresAt)
  const expired = expiresAt.getTime() <= Date.now()
  const link = created?.connectionId === live.id ? created.url : null
  const note = [
    link && "Copy it now, it won't be shown again.",
    !expired && `Expires ${expiryTime(expiresAt, { timeFormat: preferences?.timeFormat })}.`,
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className="space-y-3 p-1">
      <Label className="text-sm font-medium">Invite link</Label>
      {link ? (
        <InviteLink url={link} />
      ) : (
        <div className="rounded-lg border px-3 py-3 text-sm text-muted-foreground">
          {expired ? "This link has expired." : "Waiting for another workspace to accept."}
        </div>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <div className="flex flex-wrap gap-2">
        {!blocked && (
          <Button variant="outline" size="sm" onClick={() => create.mutate()} disabled={busy}>
            {create.isPending ? "Creating…" : "New link"}
          </Button>
        )}
        {!expired && (
          <Button variant="outline" size="sm" onClick={() => revoke.mutate(live.id)} disabled={busy}>
            {revoke.isPending ? "Revoking…" : "Revoke"}
          </Button>
        )}
      </div>
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
    </div>
  )
}

function InviteLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopyFailed(false)
      setCopied(true)
      window.setTimeout(() => setCopied(false), COPY_CONFIRMATION_MS)
    } catch {
      setCopyFailed(true)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
        <input
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="Invite link"
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : "Copy link"}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      {copyFailed && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't copy the link. Select it and copy it yourself.
        </p>
      )}
    </>
  )
}
