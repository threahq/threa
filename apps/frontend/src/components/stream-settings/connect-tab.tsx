import { useEffect, useId, useState } from "react"
import { Building2, Link as LinkIcon } from "lucide-react"
import { StreamConnectionErrorCodes, StreamConnectionStates, type Stream } from "@threahq/types"
import { ApiError } from "@/api/client"
import { CopyableLink } from "@/components/copyable-link"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { usePreferences } from "@/contexts"
import { formatFutureTime, formatTime, type TimePrefs } from "@/lib/dates"
import { buildStreamConnectionInviteLink } from "@/lib/stream-links"
import {
  createStreamConnectionInvite,
  revokeStreamConnection,
  useLoadStreamConnections,
  useStreamConnections,
} from "@/stores/stream-connections-store"
import { useWorkspaceUsers } from "@/stores/workspace-store"

const HOUR_MS = 60 * 60_000

const REFUSAL_COPY: Partial<Record<string, string>> = {
  [StreamConnectionErrorCodes.DISABLED]: "Shared channels are turned off for this workspace.",
  FORBIDDEN: "Only workspace admins can share channels.",
}

const CREATE_ERROR_COPY: Partial<Record<string, string>> = {
  ...REFUSAL_COPY,
  [StreamConnectionErrorCodes.NOT_SHAREABLE]: "Only active, unencrypted channels can be shared.",
  [StreamConnectionErrorCodes.TOO_MANY_INVITES]: "This channel has too many open links. Revoke one to create another.",
}

function createErrorMessage(error: unknown): string {
  return (ApiError.isApiError(error) && CREATE_ERROR_COPY[error.code]) || "Couldn't create the link. Try again."
}

const REVOKE_ERROR_COPY: Partial<Record<string, string>> = {
  ...REFUSAL_COPY,
  [StreamConnectionErrorCodes.ALREADY_ACCEPTED]: "Another workspace already accepted this invite.",
  [StreamConnectionErrorCodes.NOT_FOUND]: "This link no longer exists.",
}

function revokeErrorMessage(error: unknown): string {
  return (ApiError.isApiError(error) && REVOKE_ERROR_COPY[error.code]) || "Couldn't revoke the link. Try again."
}

/** formatFutureTime counts down minutes inside the last hour, which an open tab would leave stale. */
function expiryTime(expiresAt: number, prefs: TimePrefs): string {
  const date = new Date(expiresAt)
  if (expiresAt - Date.now() < HOUR_MS) return formatTime(date, prefs)
  return formatFutureTime(date, new Date(), prefs)
}

function unshareableReason(stream: Stream): string | null {
  if (stream.archivedAt) return "Archived channels can't be shared."
  if (stream.e2eEnabled) return "Encrypted channels can't be shared."
  return null
}

interface ConnectTabProps {
  workspaceId: string
  stream: Stream
  /** Links created while the dialog is open, by connection id. */
  inviteLinks: ReadonlyMap<string, string>
  onInviteLinkCreated: (connectionId: string, url: string) => void
}

export function ConnectTab({ workspaceId, stream, inviteLinks, onInviteLinkCreated }: ConnectTabProps) {
  const { preferences } = usePreferences()
  const users = useWorkspaceUsers(workspaceId)
  const load = useLoadStreamConnections(workspaceId, stream.id)
  const rows = useStreamConnections(workspaceId, stream.id)
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  // A revoke's error sits above the lists, a create's beside its button: each where the admin is looking.
  const [actionError, setActionError] = useState<{ action: "create" | "revoke"; message: string } | null>(null)

  const [now, setNow] = useState(Date.now)
  const connected = (rows ?? []).filter((row) => row.state === StreamConnectionStates.ACTIVE)
  const pending = (rows ?? []).filter(
    (row) => row.state === StreamConnectionStates.INVITED && Date.parse(row.expiresAt) > now
  )
  const empty = connected.length === 0 && pending.length === 0
  const nextExpiry = pending.length > 0 ? Math.min(...pending.map((row) => Date.parse(row.expiresAt))) : null
  useEffect(() => {
    if (nextExpiry === null) return
    const timer = window.setTimeout(() => setNow(Date.now()), nextExpiry - Date.now())
    return () => window.clearTimeout(timer)
  }, [nextExpiry, now])

  if (rows === undefined || (load.status === "loading" && empty)) {
    return (
      <div className="space-y-3 p-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  const refusal = ApiError.isApiError(load.error) && REFUSAL_COPY[load.error.code]
  const loadFailed = load.status === "failed" && (
    <div className="space-y-3">
      <p role="alert" className="text-sm text-destructive">
        {refusal || "Couldn't load this channel's connections."}
      </p>
      {!refusal && (
        <Button variant="outline" size="sm" onClick={load.retry}>
          Try again
        </Button>
      )}
    </div>
  )
  if (loadFailed && (refusal || empty)) return <div className="p-1">{loadFailed}</div>

  const create = async () => {
    setActionError(null)
    setCreating(true)
    try {
      await createStreamConnectionInvite(workspaceId, stream.id, (connectionId, token) =>
        onInviteLinkCreated(connectionId, buildStreamConnectionInviteLink(token))
      )
    } catch (error) {
      setActionError({ action: "create", message: createErrorMessage(error) })
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (connectionId: string) => {
    setActionError(null)
    setRevokingId(connectionId)
    try {
      await revokeStreamConnection(workspaceId, stream.id, connectionId)
    } catch (error) {
      setActionError({ action: "revoke", message: revokeErrorMessage(error) })
    } finally {
      setRevokingId(null)
    }
  }

  const blocked = unshareableReason(stream)
  const busy = creating || revokingId !== null
  const timePrefs = { timeFormat: preferences?.timeFormat }

  return (
    <div className="space-y-5 p-1">
      {loadFailed}
      {actionError?.action === "revoke" && <ActionError message={actionError.message} />}
      {connected.length > 0 && (
        <section className="space-y-2">
          <Label className="text-sm font-medium">Shared with</Label>
          <ul className="space-y-2">
            {connected.map((connection) => (
              <li key={connection.id} className="flex items-center gap-3 rounded-md border px-3 py-3">
                <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-sm font-medium">{connection.remoteWorkspaceName}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pending.length > 0 && (
        <section className="space-y-2">
          <Label className="text-sm font-medium">Invite links</Label>
          <ul className="space-y-4">
            {pending.map((connection) => (
              <PendingInvite
                key={connection.id}
                expiresAt={Date.parse(connection.expiresAt)}
                link={inviteLinks.get(connection.id) ?? null}
                inviterName={users.find((user) => user.id === connection.invitedBy)?.name ?? null}
                timePrefs={timePrefs}
                revoking={revokingId === connection.id}
                disabled={busy}
                onRevoke={() => void revoke(connection.id)}
              />
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-2">
        {empty && <Label className="text-sm font-medium">Share with another workspace</Label>}
        {(empty || blocked) && (
          <p className="text-sm text-muted-foreground">
            {blocked ?? "Each link lets one workspace join. Any admin there who opens it can accept."}
          </p>
        )}
        {!blocked && (
          <Button variant={empty ? "default" : "outline"} onClick={() => void create()} disabled={busy}>
            <LinkIcon className="mr-2 h-4 w-4" />
            {creating ? "Creating…" : "Create invite link"}
          </Button>
        )}
        {actionError?.action === "create" && <ActionError message={actionError.message} />}
      </section>
    </div>
  )
}

function ActionError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  )
}

function PendingInvite({
  expiresAt,
  link,
  inviterName,
  timePrefs,
  revoking,
  disabled,
  onRevoke,
}: {
  expiresAt: number
  link: string | null
  inviterName: string | null
  timePrefs: TimePrefs
  revoking: boolean
  disabled: boolean
  onRevoke: () => void
}) {
  const noteId = useId()
  const origin = link ? "Copy it now, it won't be shown again." : inviterName && `Created by ${inviterName}.`
  const note = [origin, `Expires ${expiryTime(expiresAt, timePrefs)}.`].filter(Boolean).join(" ")

  return (
    <li className="space-y-2">
      {link ? (
        <CopyableLink url={link} label="Invite link" />
      ) : (
        <div className="rounded-md border px-3 py-3 text-sm text-muted-foreground">
          Waiting for a workspace to accept.
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <p id={noteId} className="text-xs text-muted-foreground">
          {note}
        </p>
        <Button variant="outline" size="sm" onClick={onRevoke} disabled={disabled} aria-describedby={noteId}>
          {revoking ? "Revoking…" : "Revoke"}
        </Button>
      </div>
    </li>
  )
}
