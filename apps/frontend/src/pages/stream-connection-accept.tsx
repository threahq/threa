import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Ban, Check, Hourglass, Link2, SearchX, type LucideIcon } from "lucide-react"
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
} satisfies Partial<Record<StreamConnectionErrorCode, { title: string; body: string; icon: LucideIcon }>>

type LookupErrorCode = keyof typeof LOOKUP_ERROR_COPY

function lookupErrorCode(error: unknown): LookupErrorCode | null {
  if (ApiError.isApiError(error) && error.code && error.code in LOOKUP_ERROR_COPY) {
    return error.code as LookupErrorCode
  }
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
    case StreamConnectionErrorCodes.SAME_WORKSPACE:
      return "Pick a workspace other than the one sharing the channel."
    case StreamConnectionErrorCodes.EXPIRED:
      return LOOKUP_ERROR_COPY[StreamConnectionErrorCodes.EXPIRED].title
    case StreamConnectionErrorCodes.REVOKED:
      return LOOKUP_ERROR_COPY[StreamConnectionErrorCodes.REVOKED].title
    default:
      return fallback
  }
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
      <StandalonePage>
        <div className="flex w-full flex-col items-center gap-6 text-center">
          <HaloIcon icon={Link2} tone="primary" />
          <h1 className="text-2xl font-medium leading-tight">Sign in to connect a shared channel</h1>
          <Button
            className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]"
            onClick={() => login(`/connections/${encodeURIComponent(token)}`)}
          >
            Sign in
          </Button>
        </div>
      </StandalonePage>
    )
  }

  return <SignedInAccept token={token} />
}

/** Mounted only with a session: the workspace list query would otherwise 401 and bounce to login. */
function SignedInAccept({ token }: { token: string }) {
  const { workspaces, isLoading: workspacesLoading, refetch: refetchWorkspaces } = useWorkspaces()
  const lookup = useQuery({
    queryKey: ["stream-connection-lookup", token],
    queryFn: () => streamConnectionsApi.lookup(token),
    retry: false,
  })

  if (lookup.isPending || workspacesLoading) {
    return (
      <StandalonePage>
        <p className="text-sm text-muted-foreground">Loading invite…</p>
      </StandalonePage>
    )
  }

  // A failed background refetch keeps the invite it already loaded on screen.
  const data = lookup.data
  if (data === undefined) {
    const code = lookupErrorCode(lookup.error)
    if (!code) {
      return (
        <StandalonePage>
          <div className="flex w-full flex-col items-center gap-4 text-center">
            <HaloIcon icon={SearchX} />
            <h1 className="text-2xl font-medium leading-tight">Couldn't load this invite</h1>
            <Button variant="outline" className="h-11 w-full" onClick={() => void lookup.refetch()}>
              Try again
            </Button>
          </div>
        </StandalonePage>
      )
    }
    const copy = LOOKUP_ERROR_COPY[code]
    return (
      <StandalonePage>
        <div className="flex w-full flex-col items-center gap-4 text-center">
          <HaloIcon icon={copy.icon} />
          <h1 className="text-2xl font-medium leading-tight">{copy.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.body}</p>
          <OpenThreaLink />
        </div>
      </StandalonePage>
    )
  }

  if (workspaces === undefined) {
    return (
      <StandalonePage>
        <div className="flex w-full flex-col items-center gap-4 text-center">
          <HaloIcon icon={SearchX} />
          <h1 className="text-2xl font-medium leading-tight">Couldn't load your workspaces</h1>
          <Button variant="outline" className="h-11 w-full" onClick={() => void refetchWorkspaces()}>
            Try again
          </Button>
        </div>
      </StandalonePage>
    )
  }

  if (data.state === StreamConnectionStates.ACTIVE) {
    return (
      <StandalonePage>
        <Connected
          channel={channelLabel(data)}
          partnerWorkspaceId={data.partnerWorkspaceId}
          partnerWorkspaceName={data.partnerWorkspaceName}
          canOpen={workspaces.some((w) => w.id === data.partnerWorkspaceId)}
        />
      </StandalonePage>
    )
  }

  const candidates = workspaces.filter((w) => w.id !== data.hostWorkspaceId)
  if (candidates.length === 0) {
    return (
      <StandalonePage>
        <div className="flex flex-col items-center gap-4 text-center">
          <HaloIcon icon={SearchX} />
          <h1 className="text-2xl font-medium leading-tight">No other workspace to connect</h1>
          <p className="text-sm text-muted-foreground">
            Accept from a workspace you administer, other than {data.hostWorkspaceName}.
          </p>
          <OpenThreaLink />
        </div>
      </StandalonePage>
    )
  }

  return (
    <StandalonePage>
      <AcceptForm token={token} lookup={data} workspaces={candidates} />
    </StandalonePage>
  )
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
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "")
  const [visibility, setVisibility] = useState<Visibility>("private")
  const workspace = workspaces.find((w) => w.id === workspaceId)
  const accept = useMutation({
    mutationFn: () => streamConnectionsApi.accept(workspaceId, { token, visibility }),
  })
  const channel = channelLabel(lookup)

  if (accept.isSuccess) {
    return (
      <Connected
        channel={channel}
        partnerWorkspaceId={workspaceId}
        partnerWorkspaceName={workspace?.name ?? null}
        canOpen
      />
    )
  }

  return (
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
          if (workspace) accept.mutate()
        }}
      >
        <div className="space-y-2">
          <Label
            htmlFor="accept-workspace"
            className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground"
          >
            Workspace
          </Label>
          <Select
            value={workspaceId}
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
          <Label className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Visibility
          </Label>
          <VisibilityPicker
            value={visibility}
            onChange={(next) => {
              accept.reset()
              setVisibility(next)
            }}
            disabled={accept.isPending}
          />
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
  )
}

function Connected({
  channel,
  partnerWorkspaceId,
  partnerWorkspaceName,
  canOpen,
}: {
  channel: string
  partnerWorkspaceId: string | null
  partnerWorkspaceName: string | null
  canOpen: boolean
}) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <HaloIcon icon={Check} tone="primary" />
      <h1 className="text-2xl font-medium leading-tight">
        <span className="text-primary">{channel}</span> is shared with {partnerWorkspaceName ?? "another workspace"}
      </h1>
      {canOpen && partnerWorkspaceId ? (
        <Link to={`/w/${partnerWorkspaceId}`} className={LINK_CLASS}>
          Open {partnerWorkspaceName}
        </Link>
      ) : (
        <OpenThreaLink />
      )}
    </div>
  )
}

function OpenThreaLink() {
  return (
    <Link to="/" className={LINK_CLASS}>
      Open Threa
    </Link>
  )
}
