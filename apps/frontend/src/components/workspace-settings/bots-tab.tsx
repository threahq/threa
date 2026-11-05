import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import { botsApi, type CreateBotInput } from "@/api/bots"
import { Skeleton } from "@/components/ui/skeleton"
import { ChevronRight } from "lucide-react"
import { BotAvatar } from "./bot-avatar"
import { BotDetail } from "./bot-detail"
import { BotProfileDialog } from "./bot-profile-dialog"
import { SETTINGS_BOT_PARAM } from "@/contexts/settings-context"
import { useCachedWorkspaceBootstrap, workspaceKeys } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { useWorkspaceBots } from "@/stores/workspace-store"
import {
  DisabledReason,
  SETTING_ROW_CHEVRON_CLASS,
  SettingAddButton,
  SettingEmptyNote,
  SettingRow,
  SettingsSection,
} from "@/components/settings/setting-primitives"
import { settingDef } from "@/components/settings/settings-registry"
import { SETTING_MUTED_NOTE_TEXT, SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { cn } from "@/lib/utils"

type BotScope = "shared" | "personal"

interface BotsTabProps {
  workspaceId: string
  /** Workspace bots live on the workspace's Bots page, personal ones on the viewer's API keys & bots page. */
  scope: BotScope
}

export function BotsTab({ workspaceId, scope }: BotsTabProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedBotId = searchParams.get(SETTINGS_BOT_PARAM)

  const setSelectedBotId = (botId: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (botId) next.set(SETTINGS_BOT_PARAM, botId)
        else next.delete(SETTINGS_BOT_PARAM)
        return next
      },
      { replace: true }
    )
  }

  if (selectedBotId) {
    const detail = <BotDetail workspaceId={workspaceId} botId={selectedBotId} onBack={() => setSelectedBotId(null)} />
    if (scope === "shared") return <SettingsSection section="workspace-bots">{detail}</SettingsSection>
    return detail
  }

  const botSearch = (botId: string) => {
    const next = new URLSearchParams(searchParams)
    next.set(SETTINGS_BOT_PARAM, botId)
    return `?${next.toString()}`
  }

  return <BotList workspaceId={workspaceId} scope={scope} botSearch={botSearch} onSelectBot={setSelectedBotId} />
}

function BotList({
  workspaceId,
  scope,
  botSearch,
  onSelectBot,
}: {
  workspaceId: string
  scope: BotScope
  /** The search string that opens a bot's detail. */
  botSearch: (botId: string) => string
  onSelectBot: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const allCachedBots = useWorkspaceBots(workspaceId)

  const canManageShared = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE)
  const canCreateShared = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_SHARED)
  const canCreatePersonal = hasPermission(
    bootstrap?.viewerPermissions,
    WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_PERSONAL
  )

  const showSharedSection = scope === "shared" && (canManageShared || canCreateShared)
  const showPersonalSection = scope === "personal" && canCreatePersonal

  const sharedBotsQueryKey = ["bots", workspaceId, "shared"]
  const { data: sharedBots = [], isLoading: sharedLoading } = useQuery({
    queryKey: sharedBotsQueryKey,
    queryFn: () => botsApi.list(workspaceId),
    enabled: showSharedSection,
    refetchOnMount: "always",
  })

  // Personal bots come from the bootstrap-synced IDB cache filtered by type.
  const personalBots = allCachedBots.filter((b) => b.type === "personal" && !b.archivedAt)

  const [creating, setCreating] = useState(false)
  const createMutation = useMutation({
    mutationFn: (data: CreateBotInput) => botsApi.create(workspaceId, { ...data, type: scope }),
    onSuccess: (bot) => {
      setCreating(false)
      queryClient.invalidateQueries({
        queryKey: scope === "personal" ? workspaceKeys.bootstrap(workspaceId) : sharedBotsQueryKey,
      })
      onSelectBot(bot.id)
    },
  })

  const loading = !bootstrap || (showSharedSection && sharedLoading)
  const copy = BOT_SCOPE_COPY[scope]
  const visible = scope === "personal" ? showPersonalSection : showSharedSection
  const canCreate = scope === "personal" ? canCreatePersonal : canCreateShared
  const bots = scope === "personal" ? personalBots : sharedBots

  const row = (
    <SettingRow
      setting={copy.setting}
      labelFor={false}
      description={
        <>
          {settingDef(copy.setting).description}
          {!loading && !visible && <DisabledReason>{copy.denied}</DisabledReason>}
        </>
      }
      control={
        !loading &&
        visible &&
        canCreate && <SettingAddButton onClick={() => setCreating(true)}>New bot</SettingAddButton>
      }
    >
      {loading && (
        <div className="space-y-2" aria-hidden>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      )}
      {!loading &&
        visible &&
        (bots.length > 0 ? (
          <BotListItems bots={bots} workspaceId={workspaceId} botSearch={botSearch} />
        ) : (
          <SettingEmptyNote>{copy.empty}</SettingEmptyNote>
        ))}
      <BotProfileDialog
        mode="create"
        open={creating}
        onClose={() => {
          setCreating(false)
          createMutation.reset()
        }}
        namePlaceholder={copy.namePlaceholder}
        isPending={createMutation.isPending}
        error={createMutation.error}
        onSubmit={(data) => createMutation.mutate(data)}
      />
    </SettingRow>
  )

  if (scope === "personal") return row
  return <SettingsSection section="workspace-bots">{row}</SettingsSection>
}

const BOT_SCOPE_COPY = {
  personal: {
    setting: "my-bots",
    denied: "This workspace doesn't let you create bots.",
    empty: "No personal bots yet.",
    namePlaceholder: "e.g. OpenClaw, Hermes",
  },
  shared: {
    setting: "workspace-bots",
    denied: "Only workspace admins can see and manage these.",
    empty: "No workspace bots yet.",
    namePlaceholder: "e.g. GitHub Bot, Deploy Notifier",
  },
} as const

interface BotListItem {
  id: string
  name: string
  slug: string | null
  description: string | null
  avatarUrl: string | null
  avatarEmoji: string | null
}

function BotListItems({
  bots,
  workspaceId,
  botSearch,
}: {
  bots: BotListItem[]
  workspaceId: string
  botSearch: (botId: string) => string
}) {
  return (
    <ul className="divide-y divide-border">
      {bots.map((bot) => (
        <li key={bot.id}>
          <Link
            to={{ search: botSearch(bot.id) }}
            replace
            className="group -mx-4 flex min-h-11 items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
          >
            <BotAvatar bot={bot} workspaceId={workspaceId} size={32} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <span className="truncate text-sm font-medium">{bot.name}</span>
                {bot.slug && <span className={SETTING_MUTED_NOTE_TEXT}>@{bot.slug}</span>}
              </span>
              {bot.description && (
                <span className={cn("mt-0.5 block truncate text-muted-foreground", SETTING_NOTE_TEXT)}>
                  {bot.description}
                </span>
              )}
            </span>
            <ChevronRight
              aria-hidden
              className={cn(
                SETTING_ROW_CHEVRON_CLASS,
                "transition-colors group-hover:text-foreground motion-reduce:transition-none"
              )}
            />
          </Link>
        </li>
      ))}
    </ul>
  )
}
