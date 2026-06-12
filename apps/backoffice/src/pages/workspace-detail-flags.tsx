import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useParams } from "react-router-dom"
import { Section } from "@/components/layout/section"
import { InlineBanner } from "@/components/inline-banner"
import { Label } from "@/components/ui/label"
import {
  backofficeKeys,
  getWorkspaceFeatureFlags,
  listWorkspaceMembers,
  setWorkspaceFeatureFlag,
  type WorkspaceFeatureFlagDefinition,
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

  const setMutation = useMutation({
    mutationFn: (vars: { workosUserId: string; flagKey: string; value: string; defaultValue: string }) => {
      if (!id) throw new Error("Missing workspace id")
      return setWorkspaceFeatureFlag(id, {
        workosUserId: vars.workosUserId,
        flagKey: vars.flagKey,
        value: vars.value,
      })
    },
    onSuccess: (_data, vars) => {
      if (!id) return
      // Patch the overrides cache in place — the write is synchronous on the
      // control plane, so what we wrote is what a refetch would return. The
      // default value clears the override (only deviations are stored).
      queryClient.setQueryData<WorkspaceFeatureFlags>(backofficeKeys.workspaceFeatureFlags(id), (prev) => {
        if (!prev) return prev
        const rest = prev.overrides.filter((o) => !(o.workosUserId === vars.workosUserId && o.flagKey === vars.flagKey))
        if (vars.value === vars.defaultValue) return { ...prev, overrides: rest }
        return {
          ...prev,
          overrides: [
            ...rest,
            {
              workosUserId: vars.workosUserId,
              flagKey: vars.flagKey,
              value: vars.value,
              updatedAt: new Date().toISOString(),
            },
          ],
        }
      })
    },
  })

  const setError = readApiError(setMutation.error)
  const busyKey = setMutation.isPending
    ? `${setMutation.variables?.workosUserId}:${setMutation.variables?.flagKey}`
    : null

  return (
    <div className="flex flex-col gap-10">
      <Section
        label="Feature flags"
        description="Per-member rollout switches. Each flag's first declared value is the default; setting a different value propagates to the member's live sessions within seconds. Flags are temporary — retire the key from FEATURE_FLAGS once the rollout is done."
      >
        {setError ? <InlineBanner tone="error">Couldn't update flag: {setError}</InlineBanner> : null}
        <FlagsBody
          loading={flagsQ.isLoading || membersQ.isLoading}
          error={flagsQ.error ?? membersQ.error}
          flags={flagsQ.data}
          members={membersQ.data}
          busyKey={busyKey}
          onSet={(vars) => setMutation.mutate(vars)}
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
  onSet,
}: {
  loading: boolean
  error: unknown
  flags: WorkspaceFeatureFlags | undefined
  members: WorkspaceMember[] | undefined
  busyKey: string | null
  onSet: (vars: { workosUserId: string; flagKey: string; value: string; defaultValue: string }) => void
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

  if (!flags || flags.flags.length === 0) {
    return (
      <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">
        No flags in the registry — add a key to FEATURE_FLAGS in @threa/types to start a rollout.
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

  const valueFor = (workosUserId: string, flag: WorkspaceFeatureFlagDefinition): string =>
    flags.overrides.find((o) => o.workosUserId === workosUserId && o.flagKey === flag.key)?.value ?? flag.values[0]

  return (
    <ul className="divide-y border-y">
      {members.map((member) => (
        <li key={member.workosUserId} className="flex flex-wrap items-center justify-between gap-4 py-4 pl-1 pr-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-sm font-medium text-foreground">{memberDisplayName(member)}</span>
            {member.email ? <span className="truncate text-xs text-muted-foreground">{member.email}</span> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-4">
            {flags.flags.map((flag) => {
              const value = valueFor(member.workosUserId, flag)
              const isDefault = value === flag.values[0]
              const busy = busyKey === `${member.workosUserId}:${flag.key}`
              return (
                <div key={flag.key} className="flex items-center gap-2">
                  <Label
                    htmlFor={`flag-${member.workosUserId}-${flag.key}`}
                    className="font-mono text-xs text-muted-foreground"
                  >
                    {flag.key}
                  </Label>
                  <select
                    id={`flag-${member.workosUserId}-${flag.key}`}
                    value={value}
                    disabled={busy}
                    onChange={(e) =>
                      onSet({
                        workosUserId: member.workosUserId,
                        flagKey: flag.key,
                        value: e.target.value,
                        defaultValue: flag.values[0],
                      })
                    }
                    className={cn(
                      "h-8 rounded-input border border-input bg-background px-2 font-mono text-xs",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                      !isDefault && "border-emerald-500/50 bg-emerald-500/10"
                    )}
                  >
                    {flag.values.map((v, idx) => (
                      <option key={v} value={v}>
                        {v}
                        {idx === 0 ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
          </div>
        </li>
      ))}
    </ul>
  )
}
