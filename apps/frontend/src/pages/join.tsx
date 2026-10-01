import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Ban, Hourglass, Mail, RefreshCw, SearchX, UsersRound, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { HaloIcon, StandalonePage } from "@/components/standalone-page"
import { ApiError } from "@/api/client"
import {
  invitationsApi,
  INVITATION_ERROR_CODES,
  isInvitationErrorCode,
  type InvitationErrorCode,
} from "@/api/invitations"
import { formatDisplayDate } from "@/lib/dates"

interface LookupErrorCopy {
  title: string
  body: string
  icon: LucideIcon
}

const LOOKUP_ERROR_COPY = {
  [INVITATION_ERROR_CODES.NOT_FOUND]: {
    title: "Invitation not found",
    body: "This link is invalid or no longer exists. Ask the workspace admin for a fresh one.",
    icon: SearchX,
  },
  [INVITATION_ERROR_CODES.REVOKED]: {
    title: "Invitation revoked",
    body: "This invitation has been revoked. Ask the workspace admin for a new link.",
    icon: Ban,
  },
  [INVITATION_ERROR_CODES.EXPIRED]: {
    title: "Invitation expired",
    body: "This invite link has expired. Ask the workspace admin for a fresh one.",
    icon: Hourglass,
  },
  [INVITATION_ERROR_CODES.ALREADY_CLAIMED]: {
    title: "Invite link already used",
    body: "Ask the workspace admin for a new link.",
    icon: UsersRound,
  },
  [INVITATION_ERROR_CODES.EXHAUSTED]: {
    title: "Invitation link is full",
    body: "This link has reached its join limit. Ask the workspace admin to update it or send a new one.",
    icon: UsersRound,
  },
  [INVITATION_ERROR_CODES.CLAIM_LIMIT]: {
    title: "Link is busy",
    body: "This link has too many pending join requests right now. Try again in a little while, or ask the admin to send you a direct invite.",
    icon: UsersRound,
  },
  [INVITATION_ERROR_CODES.ROLLOUT_UNAVAILABLE]: {
    title: "Invitations unavailable",
    body: "Invitations are temporarily unavailable. Try again in a minute.",
    icon: RefreshCw,
  },
} satisfies Partial<Record<InvitationErrorCode, LookupErrorCopy>>

type LookupErrorCode = keyof typeof LOOKUP_ERROR_COPY

function getErrorCode(err: unknown): LookupErrorCode | null {
  if (ApiError.isApiError(err) && isInvitationErrorCode(err.code) && err.code in LOOKUP_ERROR_COPY) {
    return err.code as LookupErrorCode
  }
  return null
}

function resolveClaimErrorMessage(code: LookupErrorCode | null, err: unknown): string | null {
  if (code) return LOOKUP_ERROR_COPY[code].body
  if (err instanceof ApiError) return LOOKUP_ERROR_COPY[INVITATION_ERROR_CODES.ROLLOUT_UNAVAILABLE].body
  if (err instanceof Error) return err.message
  return null
}

export function JoinPage() {
  const { token } = useParams<{ token: string }>()
  const [email, setEmail] = useState("")
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null)
  const [alreadyMemberWorkspaceId, setAlreadyMemberWorkspaceId] = useState<string | null>(null)

  const lookupQuery = useQuery({
    queryKey: ["invitation-lookup", token],
    queryFn: () => invitationsApi.lookupLink(token!),
    enabled: !!token,
    retry: false,
  })

  const claimMutation = useMutation({
    mutationFn: (claimEmail: string) => invitationsApi.claimLink({ token: token!, email: claimEmail }),
    onSuccess: (data) => {
      setSubmittedEmail(email.trim())
      if (data.alreadyMember) {
        setAlreadyMemberWorkspaceId(data.alreadyMember.workspaceId)
      }
    },
  })

  // Reset claim state if token changes (shouldn't happen, but defensive)
  useEffect(() => {
    setSubmittedEmail(null)
    setAlreadyMemberWorkspaceId(null)
  }, [token])

  if (!token) {
    return (
      <StandalonePage>
        <ErrorState code={INVITATION_ERROR_CODES.NOT_FOUND} />
      </StandalonePage>
    )
  }

  if (lookupQuery.isLoading) {
    return (
      <StandalonePage>
        <div className="text-center">
          <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Resolving invitation</span>
          <p className="mt-3 text-sm text-muted-foreground">Just a moment…</p>
        </div>
      </StandalonePage>
    )
  }

  if (lookupQuery.isError) {
    const code = getErrorCode(lookupQuery.error) ?? INVITATION_ERROR_CODES.NOT_FOUND
    return (
      <StandalonePage>
        <ErrorState code={code} />
      </StandalonePage>
    )
  }

  const data = lookupQuery.data!

  if (submittedEmail) {
    return (
      <StandalonePage>
        <SubmittedState
          email={submittedEmail}
          workspaceName={data.workspaceName}
          alreadyMember={!!alreadyMemberWorkspaceId}
        />
      </StandalonePage>
    )
  }

  const claimError = claimMutation.error
  const claimErrorCode = getErrorCode(claimError)
  const claimErrorMessage = resolveClaimErrorMessage(claimErrorCode, claimError)

  const trimmedEmail = email.trim()
  const canSubmit = !!trimmedEmail && !claimMutation.isPending

  return (
    <StandalonePage>
      <div className="w-full space-y-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Workspace invitation</span>
          <h1 className="text-2xl font-medium leading-tight">
            You're invited to <span className="text-primary">{data.workspaceName}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {data.expiresAt ? `Expires ${formatDisplayDate(new Date(data.expiresAt))}` : "This link does not expire"}
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) claimMutation.mutate(trimmedEmail)
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label
              htmlFor="join-email"
              className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground font-medium"
            >
              Email
            </Label>
            <Input
              id="join-email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={claimMutation.isPending}
              className="h-11"
            />
          </div>

          {claimErrorMessage && <p className="text-sm text-destructive">{claimErrorMessage}</p>}

          <Button
            type="submit"
            className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]"
            disabled={!canSubmit}
          >
            {claimMutation.isPending ? "Sending…" : "Continue"}
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          Already have an account?{" "}
          <Link to="/login" className="text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </StandalonePage>
  )
}

function ErrorState({ code }: { code: LookupErrorCode }) {
  const copy = LOOKUP_ERROR_COPY[code]
  return (
    <div className="w-full space-y-6 text-center">
      <HaloIcon icon={copy.icon} tone="muted" />
      <div className="space-y-2">
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Workspace invitation</span>
        <h1 className="text-2xl font-medium leading-tight">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
      </div>
      <Button asChild variant="outline" className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]">
        <Link to="/login">Sign in instead</Link>
      </Button>
    </div>
  )
}

function SubmittedState({
  email,
  workspaceName,
  alreadyMember,
}: {
  email: string
  workspaceName: string
  alreadyMember: boolean
}) {
  if (alreadyMember) {
    return (
      <div className="w-full space-y-6 text-center">
        <HaloIcon icon={Mail} tone="muted" />
        <div className="space-y-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Already a member</span>
          <h1 className="text-2xl font-medium leading-tight">You're already in</h1>
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground">{email}</span> already belongs to{" "}
            <span className="text-foreground">{workspaceName}</span>. Sign in to continue.
          </p>
        </div>
        <Button asChild className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]">
          <Link to="/login">Sign in</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="w-full space-y-6 text-center">
      <HaloIcon icon={Mail} tone="primary" />
      <div className="space-y-2">
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Sign-in link sent</span>
        <h1 className="text-2xl font-medium leading-tight">Check your inbox</h1>
        <p className="text-sm text-muted-foreground">
          We sent a sign-in link to <span className="text-foreground">{email}</span>. Click it to join{" "}
          <span className="text-foreground">{workspaceName}</span>.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Didn't get it? Check spam, or{" "}
        <Link to="/login" className="text-foreground underline-offset-4 hover:underline">
          sign in
        </Link>{" "}
        if you already have an account.
      </p>
    </div>
  )
}
