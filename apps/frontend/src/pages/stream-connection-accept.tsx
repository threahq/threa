import { useState, type ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { Ban, Check, Hourglass, Link2, Link2Off, SearchX, type LucideIcon } from "lucide-react"
import {
  StreamConnectionErrorCodes,
  StreamConnectionStates,
  StreamTypes,
  type StreamConnectionErrorCode,
  type StreamConnectionLookupResponse,
  type Visibility,
  type Workspace,
} from "@threahq/types"
import { ApiError } from "@/api/client"
import { streamConnectionsApi } from "@/api/stream-connections"
import { HaloIcon, StandalonePage } from "@/components/standalone-page"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { VisibilityPicker } from "@/components/ui/visibility-picker"
import { useAuth } from "@/auth"
import { useWorkspaces } from "@/hooks"
import { formatRegion } from "@/lib/regions"
import { streamLabel } from "@/lib/streams"

const LINK_CLASS = "text-sm text-foreground underline-offset-4 hover:underline"
const FIELD_LABEL_CLASS = "text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground"

const LOOKUP_ERROR_COPY = {
  [StreamConnectionErrorCodes.NOT_FOUND]: {
    title: "Invite not found",
    body: "This link is wrong or no longer exists. Ask the channel's admin for a new one.",
    icon: SearchX,
  },
  [StreamConnectionErrorCodes.REVOKED]: {
    title: "Invite revoked",
    body: "The channel's admin revoked this link. Ask them for a new one.",
    icon: Ban,
  },
  [StreamConnectionErrorCodes.EXPIRED]: {
    title: "Invite expired",
    body: "Ask the channel's admin for a new link.",
    icon: Hourglass,
  },
  [StreamConnectionErrorCodes.ALREADY_ACCEPTED]: {
    title: "Invite already used",
    body: "Another workspace accepted this link. Ask the channel's admin for a new one.",
    icon: Link2Off,
  },
} satisfies Partial<Record<StreamConnectionErrorCode, { title: string; body: string; icon: LucideIcon }>>

type LookupErrorCode = keyof typeof LOOKUP_ERROR_COPY

function lookupErrorCode(error: unknown): LookupErrorCode | null {
  if (!ApiError.isApiError(error)) return null
  // A token too mangled to validate is a dead link to the viewer.
  if (error.status === 400) return StreamConnectionErrorCodes.NOT_FOUND
  if (error.code && error.code in LOOKUP_ERROR_COPY) return error.code as LookupErrorCode
  return null
}

function acceptErrorMessage(error: unknown): string {
  const fallback = "Couldn't accept the invite. Try again."
  if (!ApiError.isApiError(error)) return fallback
  if (error.status === 403) return "Only admins of that workspace can accept."
  switch (error.code) {
    case StreamConnectionErrorCodes.DISABLED:
      return "Shared channels aren't turned on for that workspace."
    case StreamConnectionErrorCodes.ALREADY_ACCEPTED:
      return "Another workspace already accepted this invite."
    case StreamConnectionErrorCodes.NOT_SHAREABLE:
      return "The host stopped sharing this channel. Ask the channel's admin about it."
    case StreamConnectionErrorCodes.EXPIRED:
      return LOOKUP_ERROR_COPY[StreamConnectionErrorCodes.EXPIRED].title
    case StreamConnectionErrorCodes.REVOKED:
      return LOOKUP_ERROR_COPY[StreamConnectionErrorCodes.REVOKED].title
    default:
      return fallback
  }
}

function lookupKey(token: string) {
  return ["stream-connection-lookup", token] as const
}

function channelLabel(lookup: StreamConnectionLookupResponse): string {
  return streamLabel({ type: StreamTypes.CHANNEL, slug: lookup.streamSlug, displayName: lookup.streamDisplayName })
}

export function StreamConnectionAcceptPage() {
  const { token = "" } = useParams<{ token: string }>()
  const { user, loading: authLoading, login } = useAuth()

  if (authLoading) return <StandalonePage />

  if (!user) {
    return (
      <StatusScreen icon={Link2} tone="primary" title="Sign in to connect a shared channel">
        <Button
          className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]"
          onClick={() => login(`/connections/${encodeURIComponent(token)}`)}
        >
          Sign in
        </Button>
      </StatusScreen>
    )
  }

  return <SignedInAccept token={token} />
}

/** Mounted only with a session: the workspace list query would otherwise 401 and bounce to login. */
function SignedInAccept({ token }: { token: string }) {
  const { workspaces, isLoading: workspacesLoading, refetch: refetchWorkspaces } = useWorkspaces()
  const lookup = useQuery({
    queryKey: lookupKey(token),
    queryFn: () => streamConnectionsApi.lookup(token),
    retry: false,
  })
  const invite = lookup.data?.state === StreamConnectionStates.INVITED ? lookup.data : null
  const candidates = invite && workspaces ? workspaces.filter((w) => w.id !== invite.hostWorkspaceId) : []
  const canAccept = useQueries({
    queries: candidates.map((w) => ({
      queryKey: ["stream-connection-can-accept", w.id],
      queryFn: () => streamConnectionsApi.canAccept(w.id),
      retry: false,
    })),
  })

  if (lookup.isPending || workspacesLoading) return <LoadingInvite />

  // A link that died since it loaded wins over the invite still in the cache.
  const deadCode = lookupErrorCode(lookup.error)
  if (deadCode) {
    const copy = LOOKUP_ERROR_COPY[deadCode]
    return (
      <StatusScreen icon={copy.icon} title={copy.title}>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
        <OpenThreaLink />
      </StatusScreen>
    )
  }

  // Any other failed background refetch keeps the invite it already loaded on screen.
  const data = lookup.data
  if (data === undefined) {
    return (
      <StatusScreen icon={SearchX} title="Couldn't load this invite">
        <Button variant="outline" className="h-11 w-full" onClick={() => void lookup.refetch()}>
          Try again
        </Button>
      </StatusScreen>
    )
  }

  if (data.state === StreamConnectionStates.ACTIVE) {
    return (
      <Connected
        channel={channelLabel(data)}
        workspaceId={data.partnerWorkspaceId}
        workspaceName={data.partnerWorkspaceName}
      />
    )
  }

  if (workspaces === undefined) {
    return (
      <StatusScreen icon={SearchX} title="Couldn't load your workspaces">
        <Button variant="outline" className="h-11 w-full" onClick={() => void refetchWorkspaces()}>
          Try again
        </Button>
      </StatusScreen>
    )
  }

  if (canAccept.some((q) => q.isPending)) return <LoadingInvite />
  // A failed check keeps its workspace on offer: the accept itself says what went wrong.
  const acceptable = candidates.filter((_, i) => canAccept[i]?.data !== false)
  if (acceptable.length === 0) {
    return (
      <StatusScreen icon={SearchX} title="No other workspace to connect">
        <p className="text-sm text-muted-foreground">
          Accept from a workspace other than {data.hostWorkspaceName} where you're an admin and shared channels are
          turned on.
        </p>
        <OpenThreaLink />
      </StatusScreen>
    )
  }

  return <AcceptForm token={token} lookup={data} workspaces={acceptable} />
}

function AcceptForm({
  token,
  lookup,
  workspaces,
}: {
  token: string
  lookup: StreamConnectionLookupResponse
  workspaces: Workspace[]
}) {
  const queryClient = useQueryClient()
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "")
  const [visibility, setVisibility] = useState<Visibility>("private")
  // A rechecked workspace can drop out of the list under the selection.
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0]
  const accept = useMutation({
    mutationFn: (target: Workspace) => streamConnectionsApi.accept(target.id, { token, visibility }),
    onSuccess: async (_, target) => {
      // The accept is the answer; a refetch racing it could show the form or a dead link instead.
      await queryClient.cancelQueries({ queryKey: lookupKey(token) })
      queryClient.setQueryData<StreamConnectionLookupResponse>(lookupKey(token), {
        ...lookup,
        state: StreamConnectionStates.ACTIVE,
        partnerWorkspaceId: target.id,
        partnerWorkspaceName: target.name,
      })
    },
    // A link that died while the form was open shows as dead, not as an error under the form.
    onError: () => void queryClient.invalidateQueries({ queryKey: lookupKey(token) }),
  })
  const channel = channelLabel(lookup)

  return (
    <StandalonePage>
      <div className="w-full space-y-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <HaloIcon icon={Link2} tone="primary" />
          <h1 className="text-2xl font-medium leading-tight">
            <span className="text-primary">{channel}</span> from {lookup.hostWorkspaceName}
          </h1>
          <p className="text-sm text-muted-foreground">
            Hosted in {formatRegion(lookup.hostRegion)}. Messages your workspace posts in this channel are stored there
            too.
          </p>
        </div>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (workspace) accept.mutate(workspace)
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="accept-workspace" className={FIELD_LABEL_CLASS}>
              Workspace
            </Label>
            <Select
              value={workspace?.id ?? ""}
              onValueChange={(id) => {
                accept.reset()
                setWorkspaceId(id)
              }}
              disabled={accept.isPending}
            >
              <SelectTrigger id="accept-workspace" className="h-11">
                <SelectValue placeholder="Choose a workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label id="accept-visibility" className={FIELD_LABEL_CLASS}>
              Visibility
            </Label>
            <div role="group" aria-labelledby="accept-visibility">
              <VisibilityPicker
                value={visibility}
                onChange={(next) => {
                  accept.reset()
                  setVisibility(next)
                }}
                disabled={accept.isPending}
              />
            </div>
          </div>
          {accept.isError && (
            <p role="alert" className="text-sm text-destructive">
              {acceptErrorMessage(accept.error)}
            </p>
          )}
          <Button
            type="submit"
            className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]"
            disabled={accept.isPending || !workspace}
          >
            {accept.isPending ? "Accepting…" : "Accept"}
          </Button>
        </form>
      </div>
    </StandalonePage>
  )
}

function StatusScreen({
  icon,
  tone,
  title,
  children,
}: {
  icon: LucideIcon
  tone?: "primary"
  title: ReactNode
  children: ReactNode
}) {
  return (
    <StandalonePage>
      <div className="flex w-full flex-col items-center gap-4 text-center">
        <HaloIcon icon={icon} tone={tone} />
        <h1 className="text-2xl font-medium leading-tight">{title}</h1>
        {children}
      </div>
    </StandalonePage>
  )
}

function Connected({
  channel,
  workspaceId,
  workspaceName,
}: {
  channel: string
  workspaceId: string
  workspaceName: string
}) {
  return (
    <StatusScreen
      icon={Check}
      tone="primary"
      title={
        <>
          <span className="text-primary">{channel}</span> is shared with {workspaceName}
        </>
      }
    >
      <Link to={`/w/${workspaceId}`} className={LINK_CLASS}>
        Open {workspaceName}
      </Link>
    </StatusScreen>
  )
}

function LoadingInvite() {
  return (
    <StandalonePage>
      <p className="text-sm text-muted-foreground">Loading invite…</p>
    </StandalonePage>
  )
}

function OpenThreaLink() {
  return (
    <Link to="/" className={LINK_CLASS}>
      Open Threa
    </Link>
  )
}
