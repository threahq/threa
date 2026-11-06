import { type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useParams } from "react-router-dom"
import { ChevronRight, ExternalLink } from "lucide-react"
import { WORKSPACE_TIERS, WORKSPACE_TIER_VALUES, type WorkspaceTier } from "@threahq/types"
import { Section } from "@/components/layout/section"
import { InlineBanner } from "@/components/inline-banner"
import { CARD_CLASS, ListPlaceholder, ROW_PADDING } from "@/components/layout/rows"
import { NativeSelect } from "@/components/ui/native-select"
import {
  backofficeKeys,
  getBackofficeConfig,
  setWorkspaceTier,
  type BackofficeConfig,
  type WorkspaceDetail,
  type WorkspaceOwnerSummary,
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
        {workspace.owner ? <OwnerFields owner={workspace.owner} /> : <ListPlaceholder>Unclaimed</ListPlaceholder>}
      </Section>

      <Section label="Details">
        <FieldGrid>
          <Field
            label="Workspace id"
            value={
              appBaseUrl ? (
                <ExternalIdLink href={buildWorkspaceUrl(appBaseUrl, workspace.id)}>{workspace.id}</ExternalIdLink>
              ) : (
                <span className="break-all font-mono text-[0.8125rem]">{workspace.id}</span>
              )
            }
          />
          <Field label="Region" value={workspace.region} />
          <Field label="Tier" value={<WorkspaceTierSelect workspaceId={workspace.id} tier={workspace.tier} />} />
          <Field label="Members" value={workspace.memberCount.toString()} to={`/workspaces/${workspace.id}/members`} />
          <Field
            label="WorkOS organization"
            value={renderWorkosOrgValue(workspace.workosOrganizationId, workosEnvId)}
          />
          <Field label="Created" value={formatDateTime(workspace.createdAt)} />
          <Field label="Updated" value={formatDateTime(workspace.updatedAt)} />
        </FieldGrid>
      </Section>
    </div>
  )
}

function OwnerFields({ owner }: { owner: WorkspaceOwnerSummary }) {
  return (
    <FieldGrid>
      <Field label="Name" value={owner.name ?? "Unknown"} />
      <Field
        label="Email"
        value={
          owner.email ? (
            <span className="break-words">{owner.email}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        }
      />
      <Field
        label="WorkOS user"
        value={<span className="break-all font-mono text-[0.8125rem]">{owner.workosUserId}</span>}
      />
    </FieldGrid>
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
    <div className="flex flex-col gap-2 sm:items-end">
      <NativeSelect
        aria-label="Tier"
        value={mutation.isPending ? mutation.variables : tier}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.value as WorkspaceTier)}
        className="w-full sm:w-48"
      >
        {WORKSPACE_TIER_VALUES.map((value) => (
          <option key={value} value={value}>
            {TIER_LABELS[value]}
          </option>
        ))}
      </NativeSelect>
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
    return <span className="break-all font-mono text-[0.8125rem]">{orgId}</span>
  }
  return <ExternalIdLink href={buildWorkosOrgUrl(envId, orgId)}>{orgId}</ExternalIdLink>
}

function ExternalIdLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex max-w-full items-center gap-1.5 break-all font-mono text-[0.8125rem] text-foreground underline-offset-4 hover:text-primary hover:underline"
    >
      <span className="break-all">{children}</span>
      <ExternalLink className="size-3 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
    </a>
  )
}

function FieldGrid({ children }: { children: ReactNode }) {
  return <dl className={cn(CARD_CLASS, "divide-y")}>{children}</dl>
}

const FIELD_ROW = cn(
  "flex min-h-12 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
  ROW_PADDING
)

function Field({ label, value, to }: { label: string; value: ReactNode; to?: string }) {
  return (
    <div className={FIELD_ROW}>
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground sm:text-right">
        {to ? (
          <Link
            to={to}
            className="group inline-flex items-center gap-1 rounded-sm font-medium underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {value}
            <ChevronRight aria-hidden className="size-4 text-muted-foreground group-hover:text-primary" />
          </Link>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}
