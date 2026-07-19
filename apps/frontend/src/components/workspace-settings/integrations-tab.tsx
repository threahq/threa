import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Github, ExternalLink, RefreshCw } from "lucide-react"
import { WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import { integrationsApi } from "@/api/integrations"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"

interface IntegrationsTabProps {
  workspaceId: string
}

// No Lucide icon for Linear — inline SVG matching the Linear brand mark sizing.
function LinearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} fill="currentColor" aria-hidden="true">
      <path d="M1.224 61.95A50 50 0 0 0 38.05 98.776L1.224 61.95Zm-.931-11.928 48.686 48.685a50 50 0 0 1-12.22-3.04L3.333 62.24a50 50 0 0 1-3.04-12.218Zm3.083-19.248 65.85 65.85a50 50 0 0 1-7.673-2.708L3.668 38.448a50 50 0 0 1-2.708-7.674Zm6.587-11.542c9.025-11.48 23.034-18.8 38.75-18.8 27.229 0 49.287 22.058 49.287 49.287 0 15.716-7.32 29.726-18.8 38.751l-69.237-69.237Z" />
    </svg>
  )
}

export function IntegrationsTab({ workspaceId }: IntegrationsTabProps) {
  const queryClient = useQueryClient()

  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)

  const query = useQuery({
    queryKey: ["workspace-integrations", workspaceId, "github"],
    queryFn: () => integrationsApi.getGithub(workspaceId),
    enabled: canManage,
  })

  const linearQuery = useQuery({
    queryKey: ["workspace-integrations", workspaceId, "linear"],
    queryFn: () => integrationsApi.getLinear(workspaceId),
    enabled: canManage,
  })

  const disconnectMutation = useMutation({
    mutationFn: (integrationId: string) => integrationsApi.disconnectGithub(workspaceId, integrationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspace-integrations", workspaceId, "github"] })
    },
  })

  const syncMutation = useMutation({
    mutationFn: (integrationId: string) => integrationsApi.syncGithub(workspaceId, integrationId),
    onSuccess: (data) => {
      queryClient.setQueryData(["workspace-integrations", workspaceId, "github"], data)
    },
  })

  const disconnectLinearMutation = useMutation({
    mutationFn: () => integrationsApi.disconnectLinear(workspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspace-integrations", workspaceId, "linear"] })
    },
  })

  if (!canManage) {
    return (
      <div className="space-y-4 p-1">
        <p className="text-sm text-muted-foreground">You need the Workspace Admin permission to manage integrations.</p>
      </div>
    )
  }

  if (query.isLoading || linearQuery.isLoading) {
    return (
      <div className="space-y-3 p-1">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-9 w-32" />
      </div>
    )
  }

  const configured = query.data?.configured ?? false
  const integration = query.data?.integrations?.[0] ?? null
  const repositories = integration?.repositories ?? []
  const isActive = integration?.status === "active"

  const linearConfigured = linearQuery.data?.configured ?? false
  const linearIntegration = linearQuery.data?.integration ?? null
  const linearIsActive = linearIntegration?.status === "active"

  return (
    <div className="space-y-6 p-1">
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Github className="h-4 w-4 text-foreground" />
          <h3 className="text-sm font-medium">GitHub</h3>
          {isActive && (
            <Badge variant="default" className="hover:bg-primary">
              Connected
            </Badge>
          )}
          {configured && !isActive && integration?.status === "error" && (
            <Badge variant="destructive" className="hover:bg-destructive">
              Error
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Rich previews for pull requests, issues, commits, files, and comments.
        </p>

        {!configured && (
          <p className="mt-3 text-sm text-muted-foreground">
            GitHub App credentials are not configured on this deployment yet.
          </p>
        )}

        {configured && isActive && (
          <div className="mt-3 space-y-3">
            {integration.accountLogin && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground">Organization</h4>
                <p className="text-sm">{integration.accountLogin}</p>
              </div>
            )}

            <div>
              <h4 className="text-xs font-medium text-muted-foreground">Repository access</h4>
              <p className="text-sm">
                {integration.repositorySelection === "all" ? "All repositories" : "Selected repositories"}
              </p>
            </div>

            {repositories.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground">Repositories</h4>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {repositories.slice(0, 12).map((repository) => (
                    <Badge key={repository.fullName} variant="outline" className="text-xs font-normal">
                      {repository.fullName}
                    </Badge>
                  ))}
                  {repositories.length > 12 && (
                    <span className="text-xs text-muted-foreground self-center">+{repositories.length - 12} more</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {configured && !isActive && (
          <p className="mt-3 text-sm text-muted-foreground">
            Connect the Threa GitHub App to enable authenticated workspace previews.
          </p>
        )}

        {configured && (
          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" asChild>
              <a href={`/api/workspaces/${workspaceId}/integrations/github/connect`}>
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                {isActive ? "Reconnect" : "Connect GitHub"}
              </a>
            </Button>
            {isActive && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => integration && syncMutation.mutate(integration.id)}
                disabled={syncMutation.isPending}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
                {syncMutation.isPending ? "Syncing\u2026" : "Sync repos"}
              </Button>
            )}
            {isActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => integration && disconnectMutation.mutate(integration.id)}
                disabled={disconnectMutation.isPending}
              >
                {disconnectMutation.isPending ? "Disconnecting\u2026" : "Disconnect"}
              </Button>
            )}
          </div>
        )}

        {syncMutation.error && (
          <p className="mt-2 text-sm text-destructive">
            {syncMutation.error instanceof Error ? syncMutation.error.message : "Failed to sync GitHub repositories."}
          </p>
        )}

        {query.error && (
          <p className="mt-2 text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load integration status."}
          </p>
        )}

        {disconnectMutation.error && (
          <p className="mt-2 text-sm text-destructive">
            {disconnectMutation.error instanceof Error
              ? disconnectMutation.error.message
              : "Failed to disconnect GitHub."}
          </p>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2 mb-1">
          <LinearIcon className="h-4 w-4 text-foreground" />
          <h3 className="text-sm font-medium">Linear</h3>
          {linearIsActive && (
            <Badge variant="default" className="hover:bg-primary">
              Connected
            </Badge>
          )}
          {linearConfigured && !linearIsActive && linearIntegration?.status === "error" && (
            <Badge variant="destructive" className="hover:bg-destructive">
              Error
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Rich previews for issues, comments, projects, and documents.</p>

        {!linearConfigured && (
          <p className="mt-3 text-sm text-muted-foreground">
            Linear OAuth credentials are not configured on this deployment yet.
          </p>
        )}

        {linearConfigured && linearIsActive && (
          <div className="mt-3 space-y-3">
            {linearIntegration.organizationName && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground">Organization</h4>
                <p className="text-sm">{linearIntegration.organizationName}</p>
              </div>
            )}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground">Access</h4>
              <p className="text-sm">All public teams in this workspace</p>
            </div>
            {linearIntegration.authorizedUser && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground">Installed by</h4>
                <p className="text-sm">{linearIntegration.authorizedUser.name}</p>
              </div>
            )}
          </div>
        )}

        {linearConfigured && !linearIsActive && (
          <p className="mt-3 text-sm text-muted-foreground">
            Connect the Threa Linear app to enable authenticated workspace previews.
          </p>
        )}

        {linearConfigured && (
          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" asChild>
              <a href={`/api/workspaces/${workspaceId}/integrations/linear/connect`}>
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                {linearIsActive ? "Reconnect" : "Connect Linear"}
              </a>
            </Button>
            {linearIsActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => disconnectLinearMutation.mutate()}
                disabled={disconnectLinearMutation.isPending}
              >
                {disconnectLinearMutation.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            )}
          </div>
        )}

        {linearQuery.error && (
          <p className="mt-2 text-sm text-destructive">
            {linearQuery.error instanceof Error ? linearQuery.error.message : "Failed to load Linear status."}
          </p>
        )}

        {disconnectLinearMutation.error && (
          <p className="mt-2 text-sm text-destructive">
            {disconnectLinearMutation.error instanceof Error
              ? disconnectLinearMutation.error.message
              : "Failed to disconnect Linear."}
          </p>
        )}
      </section>
    </div>
  )
}
