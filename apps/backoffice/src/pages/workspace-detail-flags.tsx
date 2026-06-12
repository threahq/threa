import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useParams } from "react-router-dom"
import { Section } from "@/components/layout/section"
import { InlineBanner } from "@/components/inline-banner"
import { Button } from "@/components/ui/button"
import {
  backofficeKeys,
  getWorkspaceFeatureFlags,
  listWorkspaceMembers,
  setWorkspaceFeatureFlag,
  type WorkspaceFeatureFlags,
  type WorkspaceMember,
} from "@/api/backoffice"
import { ApiError, readApiError } from "@/api/client"
import { cn } from "@/lib/utils"

function memberDisplayName(m: WorkspaceMember): string {
  const parts = [m.firstName, m.lastName].filter((x): x is string => !!x && x.length > 0)
  if (parts.length > 0) return parts.join(" ")
  return m.email ?? m.workosUserId
}

export function WorkspaceDetailFlagsPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()

  const flagsQ = useQuery({
    queryKey: id ? backofficeKeys.workspaceFeatureFlags(id) : ["backoffice", "workspaces", "missing", "feature-flags"],
    queryFn: () => {
      if (!id) throw new Error("Missing workspace id")
      return getWorkspaceFeatureFlags(id)
    },
    enabled: !!id,
  })

  const membersQ = useQuery({
    queryKey: id ? backofficeKeys.workspaceMembers(id) : ["backoffice", "workspaces", "missing", "members"],
    queryFn: () => {
      if (!id) throw new Error("Missing workspace id")
      return listWorkspaceMembers(id)
    },
    enabled: !!id,
  })

  const toggleMutation = useMutation({
    mutationFn: (vars: { workosUserId: string; flagKey: string; enabled: boolean | null }) => {
      if (!id) throw new Error("Missing workspace id")
      return setWorkspaceFeatureFlag(id, vars)
    },
    onSuccess: (_data, vars) => {
      if (!id) return
      // Patch the overrides cache in place — the write is synchronous on the
      // control plane, so what we wrote is what a refetch would return.
      queryClient.setQueryData<WorkspaceFeatureFlags>(backofficeKeys.workspaceFeatureFlags(id), (prev) => {
        if (!prev) return prev
        const rest = prev.overrides.filter((o) => !(o.workosUserId === vars.workosUserId && o.flagKey === vars.flagKey))
        if (vars.enabled === null) return { ...prev, overrides: rest }
        return {
          ...prev,
          overrides: [
            ...rest,
            {
              workosUserId: vars.workosUserId,
              flagKey: vars.flagKey,
              enabled: vars.enabled,
              updatedAt: new Date().toISOString(),
            },
          ],
        }
      })
    },
  })

  const toggleError = readApiError(toggleMutation.error)
  const busyKey = toggleMutation.isPending
    ? `${toggleMutation.variables?.workosUserId}:${toggleMutation.variables?.flagKey}`
    : null

  return (
    <div className="flex flex-col gap-10">
      <Section
        label="Feature flags"
        description="Per-member rollout switches. Flags default to off; enabling one here propagates to the member's live sessions within seconds. Flags are temporary — retire the key from FEATURE_FLAG_KEYS once the rollout is done."
      >
        {toggleError ? <InlineBanner tone="error">Couldn't update flag: {toggleError}</InlineBanner> : null}
        <FlagsBody
          loading={flagsQ.isLoading || membersQ.isLoading}
          error={flagsQ.error ?? membersQ.error}
          flags={flagsQ.data}
          members={membersQ.data}
          busyKey={busyKey}
          onToggle={(vars) => toggleMutation.mutate(vars)}
        />
      </Section>
    </div>
  )
}

function FlagsBody({
  loading,
  error,
  flags,
  members,
  busyKey,
  onToggle,
}: {
  loading: boolean
  error: unknown
  flags: WorkspaceFeatureFlags | undefined
  members: WorkspaceMember[] | undefined
  busyKey: string | null
  onToggle: (vars: { workosUserId: string; flagKey: string; enabled: boolean | null }) => void
}) {
  if (loading) {
    return <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">Loading feature flags…</div>
  }

  if (error) {
    const notFound = ApiError.isApiError(error) && error.status === 404
    return (
      <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">
        {notFound ? "That workspace doesn't exist." : "Couldn't load feature flags."}
      </div>
    )
  }

  if (!flags || flags.flagKeys.length === 0) {
    return (
      <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">
        No flags in the registry — add a key to FEATURE_FLAG_KEYS in @threa/types to start a rollout.
      </div>
    )
  }

  if (!members || members.length === 0) {
    return (
      <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">
        No members to flag — the WorkOS membership mirror is empty for this workspace.
      </div>
    )
  }

  const enabledFor = (workosUserId: string, flagKey: string): boolean =>
    flags.overrides.some((o) => o.workosUserId === workosUserId && o.flagKey === flagKey && o.enabled)

  return (
    <ul className="divide-y border-y">
      {members.map((member) => (
        <li key={member.workosUserId} className="flex flex-wrap items-center justify-between gap-4 py-4 pl-1 pr-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-sm font-medium text-foreground">{memberDisplayName(member)}</span>
            {member.email ? <span className="truncate text-xs text-muted-foreground">{member.email}</span> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {flags.flagKeys.map((flagKey) => {
              const enabled = enabledFor(member.workosUserId, flagKey)
              const busy = busyKey === `${member.workosUserId}:${flagKey}`
              return (
                <FlagToggle
                  key={flagKey}
                  flagKey={flagKey}
                  enabled={enabled}
                  busy={busy}
                  // Turning a flag off clears the override entirely (back to
                  // the default) rather than storing an explicit false.
                  onToggle={() =>
                    onToggle({ workosUserId: member.workosUserId, flagKey, enabled: enabled ? null : true })
                  }
                />
              )
            })}
          </div>
        </li>
      ))}
    </ul>
  )
}

function FlagToggle({
  flagKey,
  enabled,
  busy,
  onToggle,
}: {
  flagKey: string
  enabled: boolean
  busy: boolean
  onToggle: () => void
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      role="switch"
      aria-checked={enabled}
      disabled={busy}
      onClick={onToggle}
      className={cn("gap-2 font-mono text-xs", enabled && "border-emerald-500/50 bg-emerald-500/10")}
    >
      <span
        className={cn("size-2 rounded-full", enabled ? "bg-emerald-500" : "bg-muted-foreground/40")}
        aria-hidden="true"
      />
      {flagKey}
      <span className="text-muted-foreground">{enabled ? "on" : "off"}</span>
    </Button>
  )
}
