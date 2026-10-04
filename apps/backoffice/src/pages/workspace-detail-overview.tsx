import { type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useParams } from "react-router-dom"
import { ExternalLink } from "lucide-react"
import { WORKSPACE_TIERS, type WorkspaceTier } from "@threahq/types"
import { Section } from "@/components/layout/section"
import { InlineBanner } from "@/components/inline-banner"
import {
  backofficeKeys,
  getBackofficeConfig,
  setWorkspaceTier,
  type BackofficeConfig,
  type WorkspaceDetail,
} from "@/api/backoffice"
import { readApiError } from "@/api/client"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const TIER_LABELS: Record<WorkspaceTier, string> = {
  [WORKSPACE_TIERS.FULL]: "Full",
  [WORKSPACE_TIERS.CONNECT]: "Connect",
}

function buildWorkspaceUrl(appBaseUrl: string, workspaceId: string): string {
  // The user-facing app routes workspaces under `/w/<id>`, not `/ws/<id>`.
  return `${appBaseUrl}/w/${workspaceId}`
}

function buildWorkosOrgUrl(envId: string, orgId: string): string {
  return `https://dashboard.workos.com/${envId}/organizations/${orgId}`
}

export function WorkspaceDetailOverviewPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()

  // Cache-only observer: the layout owns the actual fetch and only renders
  // this tab once the workspace query has data, so reading directly from the
  // cache here is safe and avoids a duplicate request.
  const query = useQuery({
    queryKey: id ? backofficeKeys.workspace(id) : ["backoffice", "workspaces", "missing"],
    queryFn: () => (id ? (queryClient.getQueryData<WorkspaceDetail>(backofficeKeys.workspace(id)) ?? null) : null),
    enabled: !!id,
    staleTime: Infinity,
  })

  const configQ = useQuery({
    queryKey: backofficeKeys.config,
    queryFn: getBackofficeConfig,
    staleTime: Infinity,
  })

  if (!query.data) return null
  return <WorkspaceDetailBody workspace={query.data} config={configQ.data} />
}

function WorkspaceDetailBody({
  workspace,
  config,
}: {
  workspace: WorkspaceDetail
  config: BackofficeConfig | undefined
}) {
  const appBaseUrl = config?.workspaceAppBaseUrl?.length ? config.workspaceAppBaseUrl : null
  const workosEnvId = config?.workosEnvironmentId ?? null

  return (
    <div className="flex flex-col gap-10">
      <Section label="Owner">
        <FieldGrid>
          <Field label="Name" value={workspace.owner.name ?? "Unknown"} />
          <Field
            label="Email"
            value={
              workspace.owner.email ? (
                <span className="break-words">{workspace.owner.email}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )
            }
          />
          <Field
            label="WorkOS user"
            value={<span className="break-all font-mono text-xs">{workspace.owner.workosUserId}</span>}
            span={2}
          />
        </FieldGrid>
      </Section>

      <Section label="Details">
        <FieldGrid>
          <Field
            label="Workspace id"
            value={
              appBaseUrl ? (
                <ExternalIdLink href={buildWorkspaceUrl(appBaseUrl, workspace.id)}>{workspace.id}</ExternalIdLink>
              ) : (
                <span className="break-all font-mono text-xs">{workspace.id}</span>
              )
            }
            span={2}
          />
          <Field label="Region" value={workspace.region} />
          <Field label="Tier" value={<WorkspaceTierSelect workspaceId={workspace.id} tier={workspace.tier} />} />
          <Field label="Members" value={workspace.memberCount.toString()} to={`/workspaces/${workspace.id}/members`} />
          <Field
            label="WorkOS organization"
            value={renderWorkosOrgValue(workspace.workosOrganizationId, workosEnvId)}
            span={2}
          />
          <Field label="Created" value={formatDateTime(workspace.createdAt)} />
          <Field label="Updated" value={formatDateTime(workspace.updatedAt)} />
        </FieldGrid>
      </Section>
    </div>
  )
}

function WorkspaceTierSelect({ workspaceId, tier }: { workspaceId: string; tier: WorkspaceTier }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (next: WorkspaceTier) => setWorkspaceTier(workspaceId, next),
    onSuccess: (saved) => {
      queryClient.setQueryData<WorkspaceDetail>(backofficeKeys.workspace(workspaceId), (current) =>
        current ? { ...current, tier: saved } : current
      )
    },
  })
  const error = readApiError(mutation.error)

  return (
    <div className="flex flex-col gap-2">
      <select
        aria-label="Tier"
        value={mutation.isPending ? mutation.variables : tier}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.value as WorkspaceTier)}
        className="h-10 w-full rounded-input border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-48"
      >
        {Object.values(WORKSPACE_TIERS).map((value) => (
          <option key={value} value={value}>
            {TIER_LABELS[value]}
          </option>
        ))}
      </select>
      {error ? <InlineBanner tone="error">{error}</InlineBanner> : null}
    </div>
  )
}

function renderWorkosOrgValue(orgId: string | null, envId: string | null): ReactNode {
  if (!orgId) {
    return <span className="text-muted-foreground">Not linked</span>
  }
  if (!envId) {
    // We have an org id but no environment id — render as plain mono text
    // so the admin can still copy/paste it manually.
    return <span className="break-all font-mono text-xs">{orgId}</span>
  }
  return <ExternalIdLink href={buildWorkosOrgUrl(envId, orgId)}>{orgId}</ExternalIdLink>
}

function ExternalIdLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex max-w-full items-center gap-1.5 break-all font-mono text-xs text-foreground underline-offset-4 hover:text-primary hover:underline"
    >
      <span className="break-all">{children}</span>
      <ExternalLink className="size-3 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
    </a>
  )
}

function FieldGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-1 gap-x-8 gap-y-5 border-t pt-5 sm:grid-cols-2">{children}</dl>
}

function Field({ label, value, span = 1, to }: { label: string; value: ReactNode; span?: 1 | 2; to?: string }) {
  const wrapperClass = span === 2 ? "flex flex-col gap-1.5 sm:col-span-2" : "flex flex-col gap-1.5"
  if (to) {
    return (
      <Link to={to} className={cn(wrapperClass, "group rounded-sm transition-colors hover:text-primary")}>
        <dt className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground transition-colors group-hover:text-primary">
          {label}
        </dt>
        <dd className="text-sm text-foreground transition-colors group-hover:text-primary group-hover:underline group-hover:underline-offset-4">
          {value}
        </dd>
      </Link>
    )
  }
  return (
    <div className={wrapperClass}>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  )
}
