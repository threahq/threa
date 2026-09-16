import { useState } from "react"
import { useParams } from "react-router-dom"
import type { AISpendingOverview } from "@threahq/types"
import { Section } from "@/components/layout/section"
import { InlineBanner } from "@/components/inline-banner"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { ApiError } from "@/api/client"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  STAGE_CUTOFF_FIELDS,
  classifySpendingWriteError,
  formatUsd,
  useWorkspaceAISpending,
  type LimitField,
  type SpendingWriteError,
} from "./use-workspace-ai-spending"

type Spending = ReturnType<typeof useWorkspaceAISpending>
type SavedState = "missing" | "unprotected" | "disabled" | "enforced" | "emergency"

const SAVED_STATE_COPY: Record<SavedState, { label: string; detail: string }> = {
  missing: {
    label: "No policy",
    detail: "This workspace has no spending policy, so the spending ledger admits no paid AI work.",
  },
  unprotected: {
    label: "Unprotected",
    detail: "These spending controls are inactive. Existing AI budget settings still apply.",
  },
  disabled: {
    label: "AI disabled",
    detail: "The spending ledger admits no paid AI work. Saved limits are kept but not applied.",
  },
  enforced: {
    label: "Limits enforced",
    detail: "The spending ledger admits metered AI work within these limits and no other paid AI work.",
  },
  emergency: {
    label: "Emergency stop",
    detail:
      "The emergency stop is latched, so the spending ledger admits no paid AI work whatever the saved status is. It can't be cleared here.",
  },
}

const STATE_BADGE_VARIANT: Record<SavedState, "default" | "destructive" | "secondary"> = {
  missing: "secondary",
  unprotected: "secondary",
  disabled: "secondary",
  enforced: "default",
  emergency: "destructive",
}

const WRITE_ERROR_COPY: Record<Exclude<SpendingWriteError, "stale">, string> = {
  coverage: "The region no longer accepts this coverage profile. Review the metered work below and confirm it again.",
  "invalid-amount":
    "The region rejected an amount. Use a plain USD number with up to 8 decimal places, like 25 or 0.5.",
  "invalid-order":
    "The region rejected the order. Each cutoff must be at most the next one, and all must be at most the operator ceiling.",
  "workspace-missing": "The workspace's region doesn't know this workspace. Nothing was saved.",
  forbidden: "Only platform admins can change AI spending.",
  unconfirmed:
    "The region didn't confirm the change, so it may or may not have been saved. The saved state above was reloaded; check it before trying again.",
  rejected: "The request was rejected. Nothing was saved.",
}

function savedState(overview: AISpendingOverview): SavedState {
  const { policy } = overview
  if (!policy) return "missing"
  if (policy.emergencyLatched) return "emergency"
  return policy.status
}

function writeErrorMessage(error: unknown): string | null {
  if (!error) return null
  const kind = classifySpendingWriteError(error)
  if (kind === "stale")
    return "The policy version changed before confirmation. Check the saved state before trying again."
  return WRITE_ERROR_COPY[kind]
}

export function WorkspaceDetailSpendingPage() {
  const { id } = useParams<{ id: string }>()
  if (!id) return null
  return <SpendingPage key={id} workspaceId={id} />
}

function SpendingPage({ workspaceId }: { workspaceId: string }) {
  const spending = useWorkspaceAISpending(workspaceId)
  const { overviewQuery } = spending

  if (overviewQuery.isPending) {
    return <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">Loading AI spending…</div>
  }

  if (overviewQuery.isError && !overviewQuery.data) {
    const notFound = ApiError.isApiError(overviewQuery.error) && overviewQuery.error.status === 404
    return (
      <div className="flex flex-col items-center gap-3 border-y px-1 py-10 text-center text-sm text-muted-foreground">
        {notFound
          ? "That workspace doesn't exist in its region."
          : "Couldn't load AI spending from the workspace's region."}
        {notFound ? null : (
          <Button size="sm" variant="outline" onClick={() => void overviewQuery.refetch()}>
            Try again
          </Button>
        )}
      </div>
    )
  }

  const overview = overviewQuery.data
  return (
    <div className="flex flex-col gap-10">
      <SavedStatus overview={overview} spending={spending} />
      <LimitsForm overview={overview} spending={spending} />
    </div>
  )
}

function SavedStatus({ overview, spending }: { overview: AISpendingOverview; spending: Spending }) {
  const state = savedState(overview)
  const copy = SAVED_STATE_COPY[state]
  const { policy, currentPeriod } = overview
  const { overviewQuery } = spending

  return (
    <Section label="AI spending">
      {overviewQuery.isRefetchError ? (
        <InlineBanner tone="error">
          Couldn't reload from the region. This is the state loaded{" "}
          {formatDateTime(new Date(overviewQuery.dataUpdatedAt).toISOString())}.
        </InlineBanner>
      ) : null}
      <div className="divide-y border-y">
        <div className="flex flex-col gap-2 py-4 pl-1 pr-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATE_BADGE_VARIANT[state]}>{copy.label}</Badge>
            {policy && state === "emergency" ? (
              <span className="text-xs text-muted-foreground">
                Saved status: {SAVED_STATE_COPY[policy.status].label}
              </span>
            ) : null}
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{copy.detail}</p>
          {policy ? (
            <p className="text-xs text-muted-foreground">
              Version <span className="tabular-nums">{policy.version}</span>. Status changed{" "}
              {formatDateTime(policy.statusChangedAt)} by{" "}
              {policy.statusChangedBy ? <span className="font-mono">{policy.statusChangedBy}</span> : "provisioning"}.
            </p>
          ) : null}
        </div>
        {currentPeriod ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 py-4 pl-1 pr-3 sm:grid-cols-4">
            <PeriodFact term="Period started" value={formatDateTime(currentPeriod.startsAt)} />
            <PeriodFact term="Resets" value={formatDateTime(currentPeriod.endsAt)} />
            <PeriodFact term="Settled" value={formatUsd(currentPeriod.settledUsd)} numeric />
            <PeriodFact term="Committed, not yet settled" value={formatUsd(currentPeriod.committedUsd)} numeric />
          </dl>
        ) : (
          <p className="py-4 pl-1 pr-3 text-sm text-muted-foreground">
            The spending ledger has no reservations this period.
          </p>
        )}
      </div>
    </Section>
  )
}

function PeriodFact({ term, value, numeric }: { term: string; value: string; numeric?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className={cn("text-sm text-foreground", numeric && "tabular-nums [overflow-wrap:anywhere]")}>{value}</dd>
    </div>
  )
}

function LimitsForm({ overview, spending }: { overview: AISpendingOverview; spending: Spending }) {
  const [disableVersion, setDisableVersion] = useState<number | null>(null)
  const { applyMutation, disableMutation, values } = spending
  const applyError = writeErrorMessage(applyMutation.error)
  const disableError = writeErrorMessage(disableMutation.error)
  const alreadyDisabled = overview.policy?.status === "disabled"
  const busy = applyMutation.isPending || disableMutation.isPending

  return (
    <Section
      label="Limits"
      description="The spending ledger refuses a request when this period's settled and committed spend plus the request's maximum cost would pass the stage cutoff or the operator ceiling."
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          spending.apply()
        }}
      >
        <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-4">
          <div className="sm:max-w-xs">
            <AmountInput
              field="operatorCeilingUsd"
              label="Operator ceiling (USD)"
              value={values.operatorCeilingUsd}
              disabled={busy}
              onChange={spending.setLimit}
            />
          </div>
          <p className="text-xs text-muted-foreground">No stage cutoff can be set above this amount.</p>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 text-sm font-medium text-foreground">Stage cutoffs, lowest first</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STAGE_CUTOFF_FIELDS.map(({ field, label }) => (
              <AmountInput
                key={field}
                field={field}
                label={`${label} cutoff (USD)`}
                value={values[field]}
                disabled={busy}
                onChange={spending.setLimit}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 text-sm font-medium text-foreground">Metered coverage</legend>
          <p className="text-sm text-muted-foreground">
            While limits are enforced, the spending ledger admits only{" "}
            {overview.coverage.metered.map((route, index) => (
              <span key={route}>
                {index > 0 ? ", " : null}
                <span className="font-mono text-foreground">{route}</span>
              </span>
            ))}{" "}
            (profile <span className="font-mono">{overview.coverage.profile}</span>). It refuses any other paid AI work.
          </p>
          <p className="break-words text-sm text-muted-foreground">
            Model: <span className="font-mono">{overview.coverage.route.model}</span>. Provider:{" "}
            <span className="font-mono">{overview.coverage.route.providerSlug}</span>. Text only. Temperature must be
            unset for this route. Reservations cover up to {overview.coverage.route.maxPromptTokens.toLocaleString()}{" "}
            input tokens and {overview.coverage.route.maxCompletionTokens.toLocaleString()} output tokens.
          </p>
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              checked={spending.coverageAcknowledged}
              disabled={busy}
              onChange={(event) => spending.setCoverageAcknowledged(event.target.checked)}
            />
            I understand that only the metered work listed above is admitted while these limits are enforced.
          </label>
        </fieldset>

        {spending.outdatedDraft ? (
          <div className="flex flex-col gap-3">
            <InlineBanner tone="error">
              The saved policy is now version {spending.latestVersion}, newer than the one these values were edited
              from. Check the saved state above, then keep your values or discard them.
            </InlineBanner>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={spending.keepDraftOnLatest}>
                Keep my values
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={spending.discardDraft}>
                Discard my values
              </Button>
            </div>
          </div>
        ) : null}
        {applyError ? <InlineBanner tone="error">Limits not confirmed. {applyError}</InlineBanner> : null}
        {disableError ? <InlineBanner tone="error">AI disable not confirmed. {disableError}</InlineBanner> : null}

        <div className="flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" disabled={!spending.canApply}>
              {applyMutation.isPending ? "Applying…" : "Apply limits"}
            </Button>
            {spending.hasDraft && !spending.outdatedDraft ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={spending.discardDraft}>
                Discard edits
              </Button>
            ) : null}
          </div>
          {alreadyDisabled ? null : (
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => setDisableVersion(spending.latestVersion)}
            >
              {disableMutation.isPending ? "Disabling…" : "Disable AI"}
            </Button>
          )}
        </div>
      </form>

      <ResponsiveAlertDialog
        open={disableVersion !== null}
        onOpenChange={(open) => {
          if (!open) setDisableVersion(null)
        }}
      >
        <ResponsiveAlertDialogContent className="gap-5 border-t-4 border-t-destructive/70">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle className="text-xl">Disable AI for this workspace?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              The spending ledger will admit no paid AI work in this workspace until limits are applied again. Saved
              limits are kept.
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Keep AI on</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={(event) => {
                event.preventDefault()
                if (disableVersion !== null) spending.disable(disableVersion)
                setDisableVersion(null)
              }}
            >
              Disable AI
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </Section>
  )
}

function AmountInput({
  field,
  label,
  value,
  disabled,
  onChange,
}: {
  field: LimitField
  label: string
  value: string
  disabled: boolean
  onChange: (field: LimitField, value: string) => void
}) {
  const id = `ai-spending-${field}`
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className="tabular-nums"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(field, event.target.value)}
      />
    </div>
  )
}
