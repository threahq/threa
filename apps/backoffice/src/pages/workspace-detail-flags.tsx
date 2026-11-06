import { useId, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useParams } from "react-router-dom"
import { X } from "lucide-react"
import type { FeatureFlagScope } from "@threahq/types"
import { NOTE_TEXT, Section } from "@/components/layout/section"
import { CARD_CLASS, ListPlaceholder, ROW_PADDING } from "@/components/layout/rows"
import { InlineBanner } from "@/components/inline-banner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { NativeSelect } from "@/components/ui/native-select"
import { SegmentedControl } from "@/components/ui/segmented-control"
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

interface SetVars {
  subjectType: FeatureFlagScope
  subjectId: string
  flagKey: string
  value: string
  defaultValue: string
}

type Overrides = WorkspaceFeatureFlags["overrides"]

function scopeLabel(workspaceScoped: boolean, userScoped: boolean): string {
  if (workspaceScoped && userScoped) return "Workspace and members"
  return workspaceScoped ? "Workspace only" : "Members only"
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
    mutationFn: (vars: SetVars) => {
      if (!id) throw new Error("Missing workspace id")
      return setWorkspaceFeatureFlag(id, {
        subjectType: vars.subjectType,
        subjectId: vars.subjectId,
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
        const rest = prev.overrides.filter(
          (o) => !(o.subjectType === vars.subjectType && o.subjectId === vars.subjectId && o.flagKey === vars.flagKey)
        )
        if (vars.value === vars.defaultValue) return { ...prev, overrides: rest }
        return {
          ...prev,
          overrides: [
            ...rest,
            {
              subjectType: vars.subjectType,
              subjectId: vars.subjectId,
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
  const v = setMutation.variables
  const busyKey = setMutation.isPending && v ? subjectFlagKey(v.subjectType, v.subjectId, v.flagKey) : null

  return (
    <Section
      label="Feature flags"
      description="A member's value wins over the workspace's, which wins over the flag's default. Changes reach live sessions within seconds."
    >
      {setError ? <InlineBanner tone="error">Couldn't update flag: {setError}</InlineBanner> : null}
      <FlagsBody
        loading={flagsQ.isLoading || membersQ.isLoading}
        error={flagsQ.error ?? membersQ.error}
        workspaceId={id}
        flags={flagsQ.data}
        members={membersQ.data ?? []}
        busyKey={busyKey}
        onSet={(vars) => setMutation.mutate(vars)}
      />
    </Section>
  )
}

function subjectFlagKey(subjectType: FeatureFlagScope, subjectId: string, flagKey: string): string {
  return `${subjectType}:${subjectId}:${flagKey}`
}

function FlagsBody({
  loading,
  error,
  workspaceId,
  flags,
  members,
  busyKey,
  onSet,
}: {
  loading: boolean
  error: unknown
  workspaceId: string | undefined
  flags: WorkspaceFeatureFlags | undefined
  members: WorkspaceMember[]
  busyKey: string | null
  onSet: (vars: SetVars) => void
}) {
  if (loading) return <ListPlaceholder>Loading feature flags…</ListPlaceholder>

  if (error) {
    const notFound = ApiError.isApiError(error) && error.status === 404
    return (
      <ListPlaceholder>{notFound ? "That workspace doesn't exist." : "Couldn't load feature flags."}</ListPlaceholder>
    )
  }

  if (!flags || flags.flags.length === 0 || !workspaceId) {
    return (
      <ListPlaceholder>
        No flags in the registry — add a key to FEATURE_FLAGS in @threahq/types to start a rollout.
      </ListPlaceholder>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {flags.flags.map((flag) => (
        <FlagCard
          key={flag.key}
          flag={flag}
          workspaceId={workspaceId}
          overrides={flags.overrides.filter((o) => o.flagKey === flag.key)}
          members={members}
          busyKey={busyKey}
          onSet={onSet}
        />
      ))}
    </ul>
  )
}

function FlagCard({
  flag,
  workspaceId,
  overrides,
  members,
  busyKey,
  onSet,
}: {
  flag: WorkspaceFeatureFlagDefinition
  workspaceId: string
  overrides: Overrides
  members: WorkspaceMember[]
  busyKey: string | null
  onSet: (vars: SetVars) => void
}) {
  const headingId = useId()
  const [draftId, setDraftId] = useState<string | null>(null)
  const workspaceOverride = overrides.find((o) => o.subjectType === "workspace")?.value
  const workspaceValue = workspaceOverride ?? flag.default
  const workspaceScoped = flag.scopes.includes("workspace")
  const userScoped = flag.scopes.includes("user")
  const memberOverrides = overrides.filter((o) => o.subjectType === "user")
  const overridden = new Set(memberOverrides.map((o) => o.subjectId))
  const addable = userScoped ? members.filter((m) => !overridden.has(m.workosUserId) && m.workosUserId !== draftId) : []
  const set = (subjectType: FeatureFlagScope, subjectId: string, value: string) =>
    onSet({ subjectType, subjectId, flagKey: flag.key, value, defaultValue: flag.default })

  return (
    <li aria-labelledby={headingId} className={cn(CARD_CLASS, "overflow-hidden")}>
      <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6", ROW_PADDING)}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={headingId} className="break-all font-mono text-sm font-medium text-foreground">
              {flag.key}
            </h3>
            {workspaceOverride !== undefined ? <Badge tone="primary">Changed</Badge> : null}
          </div>
          <p className={cn("text-muted-foreground", NOTE_TEXT)}>
            Default <span className="font-mono">{flag.default}</span>
            <span className="px-1.5 text-muted-foreground/50">·</span>
            {scopeLabel(workspaceScoped, userScoped)}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {workspaceScoped ? (
            <SegmentedControl
              name={`flag-${flag.key}-workspace`}
              aria-label={`${flag.key} for the whole workspace`}
              value={workspaceValue}
              options={valueOptions(flag)}
              disabled={busyKey === subjectFlagKey("workspace", workspaceId, flag.key)}
              onValueChange={(value) => set("workspace", workspaceId, value)}
              className="w-full sm:w-auto sm:min-w-56"
            />
          ) : null}
          {addable.length > 0 ? (
            <NativeSelect
              compact
              aria-label={`Add a member override for ${flag.key}`}
              value=""
              onChange={(e) => setDraftId(e.target.value)}
              className="w-full sm:w-40"
            >
              <option value="" disabled>
                Add member
              </option>
              {addable.map((m) => (
                <option key={m.workosUserId} value={m.workosUserId}>
                  {memberDisplayName(m)}
                  {m.email && m.email !== memberDisplayName(m) ? ` (${m.email})` : ""}
                </option>
              ))}
            </NativeSelect>
          ) : null}
        </div>
      </div>
      {memberOverrides.length > 0 || draftId ? (
        <MemberOverrides
          flag={flag}
          inheritedValue={workspaceScoped ? workspaceValue : flag.default}
          workspaceDeviates={workspaceOverride !== undefined}
          overrides={memberOverrides}
          draftId={draftId && !overridden.has(draftId) ? draftId : null}
          onDraftDone={() => setDraftId(null)}
          members={members}
          busyKey={busyKey}
          onSet={(subjectId, value) => set("user", subjectId, value)}
        />
      ) : null}
    </li>
  )
}

function valueOptions(flag: WorkspaceFeatureFlagDefinition, unavailable?: string) {
  return flag.values.map((value) => ({
    value,
    label: <span className="font-mono text-[0.8125rem]">{value}</span>,
    disabled: value === unavailable,
  }))
}

function MemberOverrides({
  flag,
  inheritedValue,
  workspaceDeviates,
  overrides,
  draftId,
  onDraftDone,
  members,
  busyKey,
  onSet,
}: {
  flag: WorkspaceFeatureFlagDefinition
  inheritedValue: string
  workspaceDeviates: boolean
  overrides: Overrides
  draftId: string | null
  onDraftDone: () => void
  members: WorkspaceMember[]
  busyKey: string | null
  onSet: (subjectId: string, value: string) => void
}) {
  const byId = new Map(members.map((m) => [m.workosUserId, m]))
  // Writing a member's default value clears their override, so while the
  // workspace has moved off the default a member can't be pinned to it.
  const unavailable = workspaceDeviates ? flag.default : undefined

  const rows = overrides.map((o) => ({ subjectId: o.subjectId, value: o.value as string | null }))
  if (draftId) rows.push({ subjectId: draftId, value: null })

  return (
    <div className="border-t bg-muted/20">
      <div className={cn("flex items-center justify-between gap-3 px-4 py-1.5 text-muted-foreground", NOTE_TEXT)}>
        <span className="font-medium">Member overrides</span>
        <span>
          Everyone else: <span className="font-mono">{inheritedValue}</span>
        </span>
      </div>
      <ul className="divide-y border-t">
        {rows.map((row) => {
          const member = byId.get(row.subjectId)
          const name = member ? memberDisplayName(member) : row.subjectId
          const busy = busyKey === subjectFlagKey("user", row.subjectId, flag.key)
          return (
            <li
              key={row.subjectId}
              className={cn("flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6", ROW_PADDING)}
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{name}</span>
                {member?.email && member.email !== name ? (
                  <span className={cn("truncate text-muted-foreground", NOTE_TEXT)}>{member.email}</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <SegmentedControl
                  name={`flag-${flag.key}-user-${row.subjectId}`}
                  aria-label={`${flag.key} for ${name}`}
                  value={row.value}
                  options={valueOptions(flag, unavailable)}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (row.value === null) onDraftDone()
                    onSet(row.subjectId, value)
                  }}
                  className="flex-1 sm:min-w-56 sm:flex-initial"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={row.value === null ? `Cancel override for ${name}` : `Clear ${name}'s override`}
                  disabled={busy}
                  onClick={() => {
                    if (row.value === null) onDraftDone()
                    else onSet(row.subjectId, flag.default)
                  }}
                  className="size-11 shrink-0 text-muted-foreground hover:text-foreground sm:size-9 [@media(pointer:coarse)]:size-11"
                >
                  <X />
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
