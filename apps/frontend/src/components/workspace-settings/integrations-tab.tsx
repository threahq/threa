import { useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, MoreHorizontal, RefreshCw, Plus } from "lucide-react"
import { ApiError } from "@/api/client"
import { integrationKeys, integrationsApi } from "@/api/integrations"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  INACTIVE_CONTROL_CLASS,
  NOT_SET_UP_ON_SERVER,
  SETTING_CONTROL_HEIGHT,
  SETTING_CONTROL_WIDTH,
  SettingActions,
  SettingControlSkeleton,
  SettingFieldError,
  SettingRow,
  SettingsSection,
  SettingBadge,
  settingIds,
  useSettingDescribedBy,
} from "@/components/settings/setting-primitives"
import { SETTING_ICON_BUTTON, SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"
import { settingDef, type SettingId } from "@/components/settings/settings-registry"
import { accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface IntegrationsTabProps {
  workspaceId: string
}

export function IntegrationsTab({ workspaceId }: IntegrationsTabProps) {
  const queryClient = useQueryClient()

  const access = useWorkspaceAccess(workspaceId)
  const canManage = access.allowed

  const query = useQuery({
    queryKey: integrationKeys.provider(workspaceId, "github"),
    queryFn: () => integrationsApi.getGithub(workspaceId),
    enabled: canManage,
  })

  const linearQuery = useQuery({
    queryKey: integrationKeys.provider(workspaceId, "linear"),
    queryFn: () => integrationsApi.getLinear(workspaceId),
    enabled: canManage,
  })

  // Sync/disconnect failures render inside the row that was acted on — with N
  // installation rows, a section-level error can sit off-screen and a failed
  // disconnect would read as a silent no-op.
  const [actionError, setActionError] = useState<{ integrationId: string; message: string } | null>(null)

  const disconnectMutation = useMutation({
    mutationFn: (integrationId: string) => integrationsApi.disconnectGithub(workspaceId, integrationId),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationKeys.provider(workspaceId, "github") })
    },
    onError: (error, integrationId) => {
      setActionError({
        integrationId,
        message: error instanceof Error ? error.message : "Failed to disconnect GitHub.",
      })
    },
  })

  const syncMutation = useMutation({
    mutationFn: (integrationId: string) => integrationsApi.syncGithub(workspaceId, integrationId),
    onMutate: () => setActionError(null),
    onSuccess: (data) => {
      queryClient.setQueryData(integrationKeys.provider(workspaceId, "github"), data)
    },
    onError: (error, integrationId) => {
      setActionError({
        integrationId,
        message: error instanceof Error ? error.message : "Failed to sync GitHub repositories.",
      })
      // Exactly one sync failure changes the row: an installation GitHub no longer
      // knows gets parked in `error` server-side, so refetch to replace the stale
      // Connected badge. Refetching on the transient failures too would resolve
      // back to Connected and leave this message sitting under it with nothing to
      // clear it, so they leave the row alone.
      if (ApiError.isApiError(error) && error.code === "GITHUB_INSTALLATION_GONE") {
        queryClient.invalidateQueries({ queryKey: integrationKeys.provider(workspaceId, "github") })
      }
    },
  })

  const disconnectLinearMutation = useMutation({
    mutationFn: () => integrationsApi.disconnectLinear(workspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationKeys.provider(workspaceId, "linear") })
    },
  })

  const githubPurpose = settingDef("github-integration").description
  const linearPurpose = settingDef("linear-integration").description
  const loading = !access.known || (canManage && (query.isLoading || linearQuery.isLoading))
  const loadingControl = loading ? <SettingControlSkeleton className={SETTING_CONTROL_WIDTH} /> : undefined

  if (loading || !canManage) {
    return (
      <SettingsSection section="workspace-integrations">
        <SettingRow
          setting="github-integration"
          description={accessDescription("github-integration", access, {
            reason: "Only workspace admins can connect GitHub.",
          })}
          control={loadingControl}
        />
        <SettingRow
          setting="linear-integration"
          description={accessDescription("linear-integration", access, {
            reason: "Only workspace admins can connect Linear.",
          })}
          control={loadingControl}
        />
      </SettingsSection>
    )
  }

  const configured = query.data?.configured ?? false
  const githubOff = !configured && !query.error
  const installations = query.data?.integrations ?? []

  const linearConfigured = linearQuery.data?.configured ?? false
  const linearOff = !linearConfigured && !linearQuery.error
  const linearIntegration = linearQuery.data?.integration ?? null
  const linearIsActive = linearIntegration?.status === "active"
  const connectGithubHref = `/api/workspaces/${workspaceId}/integrations/github/connect`
  const githubLoadError = query.error && (
    <SettingFieldError>
      {query.error instanceof Error ? query.error.message : "Failed to load integration status."}
    </SettingFieldError>
  )
  const linearLoadError = linearQuery.error && (
    <SettingFieldError>
      {linearQuery.error instanceof Error ? linearQuery.error.message : "Failed to load Linear status."}
    </SettingFieldError>
  )

  let githubDescription: string | undefined = `Not connected. ${githubPurpose}`
  if (installations.length > 0) {
    const accounts = installations.length === 1 ? "1 account" : `${installations.length} accounts`
    githubDescription = `${accounts} connected. ${githubPurpose}`
  }

  if (!configured) githubDescription = githubPurpose

  let linearDescription: string | undefined = `Not connected. ${linearPurpose}`
  if (linearIsActive) {
    const installedBy = linearIntegration.authorizedUser
      ? ` Installed by ${linearIntegration.authorizedUser.name}.`
      : ""
    linearDescription = `Connected to ${linearIntegration.organizationName ?? "Linear"}, all public teams.${installedBy}`
  } else if (linearIntegration?.status === "error") {
    linearDescription = "The connection failed. Connect again to restore Linear previews."
  }
  if (!linearConfigured) linearDescription = linearPurpose

  return (
    <SettingsSection section="workspace-integrations">
      <SettingRow
        setting="github-integration"
        description={githubDescription}
        inactive={githubOff ? NOT_SET_UP_ON_SERVER.github.reason : undefined}
        control={
          configured ? (
            <Button size="sm" variant="outline" className={SETTING_CONTROL_HEIGHT} asChild>
              <a href={connectGithubHref}>
                {installations.length > 0 ? (
                  <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                ) : (
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                {installations.length > 0 ? "Add organization or account" : "Connect GitHub"}
              </a>
            </Button>
          ) : (
            githubOff && <UnavailableConnect setting="github-integration">Connect GitHub</UnavailableConnect>
          )
        }
      >
        {(installations.length > 0 || githubLoadError) && (
          <div className="space-y-2">
            {installations.length > 0 && (
              <ul aria-label="GitHub accounts" className="divide-y divide-border">
                {installations.map((installation) => {
                  const isActive = installation.status === "active"
                  const repositories = installation.repositories ?? []
                  const syncPending = syncMutation.isPending && syncMutation.variables === installation.id
                  const disconnectPending =
                    disconnectMutation.isPending && disconnectMutation.variables === installation.id
                  const rateLimit = installation.rateLimit
                  const accountName = installation.accountLogin ?? "GitHub installation"

                  return (
                    <li key={installation.id} className="flex items-start gap-3 py-2">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 max-w-full truncate text-sm font-medium">{accountName}</span>
                          <SettingBadge>
                            {installation.accountType === "User" ? "Personal" : "Organization"}
                          </SettingBadge>
                          {installation.status === "error" && (
                            <SettingBadge className="border-destructive/50 text-destructive">Error</SettingBadge>
                          )}
                        </div>

                        <p className={SETTING_MUTED_NOTE_TEXT}>
                          {installation.repositorySelection === "all" ? "All repositories" : "Selected repositories"}
                          {rateLimit.remaining !== null && ` · ${rateLimit.remaining} API requests remaining`}
                        </p>

                        {repositories.length > 0 && (
                          <ul aria-label="Repositories" className="flex flex-wrap gap-1.5">
                            {repositories.slice(0, 12).map((repository) => (
                              <li key={repository.fullName}>
                                <SettingBadge>{repository.fullName}</SettingBadge>
                              </li>
                            ))}
                            {repositories.length > 12 && (
                              <li className={cn("self-center", SETTING_MUTED_NOTE_TEXT)}>
                                +{repositories.length - 12} more
                              </li>
                            )}
                          </ul>
                        )}
                        {actionError?.integrationId === installation.id && (
                          <SettingFieldError>{actionError.message}</SettingFieldError>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {isActive && (
                          <Button
                            variant="outline"
                            size="sm"
                            className={SETTING_CONTROL_HEIGHT}
                            onClick={() => syncMutation.mutate(installation.id)}
                            disabled={syncPending}
                          >
                            <RefreshCw
                              className={cn(
                                "mr-1.5 h-3.5 w-3.5",
                                syncPending && "animate-spin motion-reduce:animate-none"
                              )}
                              aria-hidden
                            />
                            {syncPending ? "Syncing\u2026" : "Sync repos"}
                          </Button>
                        )}
                        {installation.status === "error" && (
                          <Button variant="outline" size="sm" className={SETTING_CONTROL_HEIGHT} asChild>
                            <a href={connectGithubHref}>
                              <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                              Reconnect
                            </a>
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={SETTING_ICON_BUTTON}
                              aria-label={`Actions for ${accountName}`}
                            >
                              <MoreHorizontal aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {installation.configurationUrl && (
                              <DropdownMenuItem asChild>
                                <a href={installation.configurationUrl} target="_blank" rel="noopener noreferrer">
                                  Repository access on GitHub
                                </a>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              disabled={disconnectPending}
                              onSelect={() => disconnectMutation.mutate(installation.id)}
                            >
                              Disconnect
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            {githubLoadError}
          </div>
        )}
      </SettingRow>

      <SettingRow
        setting="linear-integration"
        description={linearDescription}
        inactive={linearOff ? NOT_SET_UP_ON_SERVER.linear.reason : undefined}
        control={
          linearConfigured ? (
            <SettingActions>
              <Button size="sm" variant="outline" className={SETTING_CONTROL_HEIGHT} asChild>
                <a href={`/api/workspaces/${workspaceId}/integrations/linear/connect`}>
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {linearIsActive ? "Reconnect" : "Connect Linear"}
                </a>
              </Button>
              {linearIsActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={SETTING_CONTROL_HEIGHT}
                  onClick={() => disconnectLinearMutation.mutate()}
                  disabled={disconnectLinearMutation.isPending}
                >
                  {disconnectLinearMutation.isPending ? "Disconnecting…" : "Disconnect"}
                </Button>
              )}
            </SettingActions>
          ) : (
            linearOff && <UnavailableConnect setting="linear-integration">Connect Linear</UnavailableConnect>
          )
        }
      >
        {(disconnectLinearMutation.error || linearLoadError) && (
          <div className="space-y-2">
            {disconnectLinearMutation.error && (
              <SettingFieldError>
                {disconnectLinearMutation.error instanceof Error
                  ? disconnectLinearMutation.error.message
                  : "Failed to disconnect Linear."}
              </SettingFieldError>
            )}
            {linearLoadError}
          </div>
        )}
      </SettingRow>
    </SettingsSection>
  )
}

/** Connect, held in place while this installation can't connect the provider; the row's reason says why. */
function UnavailableConnect({ setting, children }: { setting: SettingId; children: ReactNode }) {
  const describedBy = useSettingDescribedBy(setting, { extra: [settingIds(setting).reason] })
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-disabled
      aria-describedby={describedBy}
      className={cn(SETTING_CONTROL_HEIGHT, INACTIVE_CONTROL_CLASS)}
    >
      <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      {children}
    </Button>
  )
}
