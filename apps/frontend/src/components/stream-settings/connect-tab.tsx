import { useEffect, useId, useState } from "react"
import { Building2 } from "lucide-react"
import { StreamConnectionErrorCodes, StreamConnectionStates, type Stream, type StreamConnection } from "@threahq/types"
import { ApiError } from "@/api/client"
import { CopyableLink } from "@/components/copyable-link"
import { Button } from "@/components/ui/button"
import {
  SETTING_CONTROL_HEIGHT,
  SettingAddButton,
  SettingFieldError,
  SettingGroupBand,
  SettingRow,
  SettingsSection,
} from "@/components/settings/setting-primitives"
import { SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"
import { cn } from "@/lib/utils"
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/components/ui/responsive-alert-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { usePreferences } from "@/contexts"
import { formatFutureTime, formatTime, type TimePrefs } from "@/lib/dates"
import { buildStreamConnectionInviteLink } from "@/lib/stream-links"
import {
  createStreamConnectionInvite,
  disconnectStreamConnection,
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

const REVOKE_ERROR_COPY: Partial<Record<string, string>> = {
  ...REFUSAL_COPY,
  [StreamConnectionErrorCodes.ALREADY_ACCEPTED]: "Another workspace already accepted this invite.",
  [StreamConnectionErrorCodes.NOT_FOUND]: "This link no longer exists.",
}

const DISCONNECT_ERROR_COPY: Partial<Record<string, string>> = {
  ...REFUSAL_COPY,
  [StreamConnectionErrorCodes.NOT_FOUND]: "This workspace is no longer connected.",
}

function errorMessage(error: unknown, copy: Partial<Record<string, string>>, fallback: string): string {
  return (ApiError.isApiError(error) && copy[error.code]) || fallback
}

/** formatFutureTime counts down minutes inside the last hour, which an open tab would leave stale. */
function expiryTime(expiresAt: number, prefs: TimePrefs): string {
  const date = new Date(expiresAt)
  if (expiresAt - Date.now() < HOUR_MS) return formatTime(date, prefs)
  return formatFutureTime(date, new Date(), prefs)
}

function unshareableReason(stream: Stream): string | null {
  if (stream.originWorkspaceId) return "Only the workspace this channel comes from can share it."
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
  const [changingId, setChangingId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<StreamConnection | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const nameIdPrefix = useId()
  // A create's error sits beside its button, the others' above the lists: each where the admin is looking.
  const [actionError, setActionError] = useState<{ action: "create" | "change"; message: string } | null>(null)

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
      <SettingsSection section="stream-sharing">
        <div className="space-y-2 px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-full" />
        </div>
      </SettingsSection>
    )
  }

  const refusal = ApiError.isApiError(load.error) && REFUSAL_COPY[load.error.code]
  const loadFailed = load.status === "failed" && (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <SettingFieldError>{refusal || "Couldn't load this channel's connections."}</SettingFieldError>
      {!refusal && (
        <Button
          variant="outline"
          className={cn("w-full shrink-0 sm:w-auto", SETTING_CONTROL_HEIGHT)}
          onClick={load.retry}
        >
          Try again
        </Button>
      )}
    </div>
  )
  if (loadFailed && (refusal || empty)) {
    return (
      <SettingsSection section="stream-sharing">
        <SettingRow setting="stream-connect" labelFor={false}>
          {loadFailed}
        </SettingRow>
      </SettingsSection>
    )
  }

  const create = async () => {
    setActionError(null)
    setCreating(true)
    try {
      await createStreamConnectionInvite(workspaceId, stream.id, (connectionId, token) =>
        onInviteLinkCreated(connectionId, buildStreamConnectionInviteLink(token))
      )
    } catch (error) {
      setActionError({
        action: "create",
        message: errorMessage(error, CREATE_ERROR_COPY, "Couldn't create the link. Try again."),
      })
    } finally {
      setCreating(false)
    }
  }

  const change = async (
    connectionId: string,
    run: typeof revokeStreamConnection,
    copy: Partial<Record<string, string>>,
    fallback: string
  ) => {
    setActionError(null)
    setChangingId(connectionId)
    try {
      await run(workspaceId, stream.id, connectionId)
    } catch (error) {
      setActionError({ action: "change", message: errorMessage(error, copy, fallback) })
    } finally {
      setChangingId(null)
    }
  }
  const revoke = (connectionId: string) =>
    change(connectionId, revokeStreamConnection, REVOKE_ERROR_COPY, "Couldn't revoke the link. Try again.")
  const disconnect = (connectionId: string) =>
    change(connectionId, disconnectStreamConnection, DISCONNECT_ERROR_COPY, "Couldn't disconnect. Try again.")

  const blocked = unshareableReason(stream)
  const busy = creating || changingId !== null
  const timePrefs = { timeFormat: preferences?.timeFormat }

  const bodyAlerts = (loadFailed || actionError?.action === "change") && (
    <div className="space-y-2">
      {loadFailed}
      {actionError?.action === "change" && <SettingFieldError>{actionError.message}</SettingFieldError>}
    </div>
  )

  return (
    <>
      <SettingsSection section="stream-sharing">
        <SettingRow
          setting="stream-connect"
          labelFor={false}
          description={
            blocked ??
            (empty ? "Each link lets one workspace join. Any admin there who opens it can accept." : undefined)
          }
          control={
            !blocked && (
              <div className="grid w-full gap-1.5 sm:w-auto sm:max-w-72 sm:justify-items-end">
                <SettingAddButton className="w-full sm:w-auto" onClick={() => void create()} disabled={busy}>
                  {creating ? "Creating…" : "Create invite link"}
                </SettingAddButton>
                {actionError?.action === "create" && <SettingFieldError>{actionError.message}</SettingFieldError>}
              </div>
            )
          }
        >
          {bodyAlerts || undefined}
        </SettingRow>
        {connected.length > 0 && (
          <SettingGroupBand label="Shared with">
            <ul className="divide-y divide-border">
              {connected.map((connection) => (
                <li key={connection.id} className="flex min-h-11 items-center gap-3 px-4 py-2">
                  <Building2 aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span
                    id={`${nameIdPrefix}-${connection.id}`}
                    className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]"
                  >
                    {connection.remoteWorkspaceName}
                  </span>
                  {connection.role !== "peer" && (
                    <Button
                      variant="outline"
                      className={cn("shrink-0", SETTING_CONTROL_HEIGHT)}
                      aria-describedby={`${nameIdPrefix}-${connection.id}`}
                      onClick={() => {
                        setConfirming(connection)
                        setConfirmOpen(true)
                      }}
                      disabled={busy}
                    >
                      {changingId === connection.id ? "Disconnecting…" : "Disconnect"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </SettingGroupBand>
        )}
        {pending.length > 0 && (
          <SettingGroupBand label="Invite links">
            <ul className="divide-y divide-border">
              {pending.map((connection) => (
                <PendingInvite
                  key={connection.id}
                  expiresAt={Date.parse(connection.expiresAt)}
                  link={inviteLinks.get(connection.id) ?? null}
                  inviterName={users.find((user) => user.id === connection.invitedBy)?.name ?? null}
                  timePrefs={timePrefs}
                  revoking={changingId === connection.id}
                  disabled={busy}
                  onRevoke={() => void revoke(connection.id)}
                />
              ))}
            </ul>
          </SettingGroupBand>
        )}
      </SettingsSection>
      <ResponsiveAlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>Disconnect {confirming?.remoteWorkspaceName}?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {confirming?.role === "partner"
                ? `The messages so far stay here, read-only, and files stop loading between the two workspaces. Sharing again takes a new invite link from ${confirming.remoteWorkspaceName}.`
                : `${confirming?.remoteWorkspaceName} keeps the messages so far, read-only, and files stop loading between the two workspaces. Sharing again takes a new invite link.`}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={() => confirming && void disconnect(confirming.id)}>
              Disconnect
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
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
    <li className="space-y-2 px-4 py-2">
      {link ? (
        <CopyableLink url={link} label="Invite link" />
      ) : (
        <p className="text-sm">Waiting for a workspace to accept.</p>
      )}
      <div className="flex min-h-11 items-center justify-between gap-3">
        <p id={noteId} className={SETTING_MUTED_NOTE_TEXT}>
          {note}
        </p>
        <Button
          variant="outline"
          className={cn("shrink-0", SETTING_CONTROL_HEIGHT)}
          onClick={onRevoke}
          disabled={disabled}
          aria-describedby={noteId}
        >
          {revoking ? "Revoking…" : "Revoke"}
        </Button>
      </div>
    </li>
  )
}
