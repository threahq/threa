import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { AISpendingLimits, AISpendingOverview, AISpendingPolicyUpdate } from "@threahq/types"
import { backofficeKeys, getWorkspaceAISpending, setWorkspaceAISpendingPolicy } from "@/api/backoffice"
import { ApiError } from "@/api/client"

export type LimitField = keyof AISpendingLimits

/** Admission order: each stage's cutoff must not exceed the next, and all sit at or below the ceiling. */
export const STAGE_CUTOFF_FIELDS = [
  { field: "agentCutoffUsd", label: "Agent" },
  { field: "enrichmentCutoffUsd", label: "Enrichment" },
  { field: "coreCutoffUsd", label: "Core" },
  { field: "embeddingCutoffUsd", label: "Embedding" },
] as const satisfies readonly { field: LimitField; label: string }[]

const EMPTY_LIMITS: AISpendingLimits = {
  agentCutoffUsd: "",
  enrichmentCutoffUsd: "",
  coreCutoffUsd: "",
  embeddingCutoffUsd: "",
  operatorCeilingUsd: "",
}

interface Draft {
  limits: AISpendingLimits
  /** The coverage profile the operator ticked, so a changed profile needs a fresh acknowledgement. */
  acknowledgedProfile: string | null
  /** Saved version the operator was looking at when they started editing. */
  baseVersion: number
}

export type SpendingWriteError =
  | "stale"
  | "coverage"
  | "invalid-amount"
  | "invalid-order"
  | "workspace-missing"
  | "forbidden"
  | "unconfirmed"
  | "rejected"

/** Error copy is owned by the page; this only classifies what the operator must do next. */
export function classifySpendingWriteError(error: unknown): SpendingWriteError {
  if (!ApiError.isApiError(error)) return "unconfirmed"
  switch (error.code) {
    case "STALE_SPEND_POLICY":
      return "stale"
    case "SPEND_COVERAGE_NOT_ACKNOWLEDGED":
      return "coverage"
    case "INVALID_USD":
      return "invalid-amount"
    case "INVALID_SPEND_POLICY":
      return "invalid-order"
  }
  if (error.status === 404) return "workspace-missing"
  if (error.status === 403) return "forbidden"
  if (error.status >= 500) return "unconfirmed"
  return "rejected"
}

/** Regional acknowledgement may have been lost, so only a fresh read says what is saved. */
function needsAuthoritativeRead(error: unknown): boolean {
  const kind = classifySpendingWriteError(error)
  return kind === "stale" || kind === "coverage" || kind === "unconfirmed"
}

function savedVersion(overview: AISpendingOverview | undefined): number {
  return overview?.policy?.version ?? 0
}

function savedLimits(overview: AISpendingOverview | undefined): AISpendingLimits {
  return overview?.policy?.limits ?? EMPTY_LIMITS
}

/**
 * Owns the operator's draft against the region's saved spending policy. The
 * draft is only ever replaced by the operator (discard, successful apply);
 * refetches change the saved state beside it, and a saved version that moved
 * past the draft's base blocks Apply until the operator reviews it.
 */
export function useWorkspaceAISpending(workspaceId: string) {
  const queryClient = useQueryClient()
  const queryKey = backofficeKeys.workspaceAISpending(workspaceId)
  const [draft, setDraft] = useState<Draft | null>(null)

  const overviewQuery = useQuery({
    queryKey,
    queryFn: () => getWorkspaceAISpending(workspaceId),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })

  const overview = overviewQuery.data
  const latestVersion = savedVersion(overview)

  const refetchAfterWrite = (error: unknown) => {
    if (needsAuthoritativeRead(error)) void queryClient.invalidateQueries({ queryKey })
  }

  const applySaved = (policy: NonNullable<AISpendingOverview["policy"]>) => {
    queryClient.setQueryData<AISpendingOverview>(queryKey, (prev) => (prev ? { ...prev, policy } : prev))
    void queryClient.invalidateQueries({ queryKey })
  }

  const applyMutation = useMutation({
    mutationFn: (update: AISpendingPolicyUpdate) => setWorkspaceAISpendingPolicy(workspaceId, update),
    onSuccess: ({ policy }) => {
      applySaved(policy)
      setDraft(null)
    },
    onError: refetchAfterWrite,
  })

  const disableMutation = useMutation({
    mutationFn: (expectedVersion: number) =>
      setWorkspaceAISpendingPolicy(workspaceId, { expectedVersion, status: "disabled" }),
    onSuccess: ({ policy }, expectedVersion) => {
      applySaved(policy)
      // Disabling keeps the saved limits, so an in-progress edit still describes the
      // same limits; move it forward only when it was based on the version just replaced.
      setDraft((prev) =>
        prev && prev.baseVersion === expectedVersion ? { ...prev, baseVersion: policy.version } : prev
      )
    },
    onError: refetchAfterWrite,
  })

  const values = draft?.limits ?? savedLimits(overview)
  const coverageAcknowledged =
    draft?.acknowledgedProfile != null && draft.acknowledgedProfile === overview?.coverage.profile
  const outdatedDraft = draft !== null && overview !== undefined && draft.baseVersion !== latestVersion
  const complete = Object.values(values).every((value) => value !== "") && coverageAcknowledged
  const pending = applyMutation.isPending || disableMutation.isPending

  const editDraft = (change: (draft: Draft) => Draft) => {
    applyMutation.reset()
    setDraft((prev) =>
      change(prev ?? { limits: savedLimits(overview), acknowledgedProfile: null, baseVersion: latestVersion })
    )
  }

  return {
    overviewQuery,
    values,
    coverageAcknowledged,
    hasDraft: draft !== null,
    outdatedDraft,
    latestVersion,
    canApply: overview !== undefined && complete && !outdatedDraft && !pending,
    applyMutation,
    disableMutation,
    setLimit: (field: LimitField, value: string) =>
      editDraft((d) => ({ ...d, limits: { ...d.limits, [field]: value } })),
    setCoverageAcknowledged: (acknowledged: boolean) =>
      editDraft((d) => ({ ...d, acknowledgedProfile: acknowledged ? (overview?.coverage.profile ?? null) : null })),
    /** Operator reviewed the newer saved policy and keeps their values against it. */
    keepDraftOnLatest: () => {
      applyMutation.reset()
      setDraft((prev) => (prev ? { ...prev, baseVersion: latestVersion, acknowledgedProfile: null } : prev))
    },
    discardDraft: () => {
      applyMutation.reset()
      setDraft(null)
    },
    apply: () => {
      if (!draft?.acknowledgedProfile || !overview || outdatedDraft || !complete) return
      applyMutation.mutate({
        expectedVersion: draft.baseVersion,
        status: "enforced",
        limits: draft.limits,
        coverageProfile: draft.acknowledgedProfile,
      })
    },
    disable: (expectedVersion: number) => disableMutation.mutate(expectedVersion),
  }
}

/**
 * Presents an exact decimal USD string with at least two fraction digits and
 * thousands separators, by string manipulation only: no float conversion, so a
 * nonzero amount like 0.00000001 never reads as zero.
 */
export function formatUsd(amount: string): string {
  const [whole, fraction = ""] = amount.split(".")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `$${grouped}.${fraction.padEnd(2, "0")}`
}
