import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { WORKSPACE_PERMISSION_SCOPES, type BotTrait } from "@threa/types"
import { botsApi, type CreateBotInput } from "@/api/bots"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Plus, BotIcon, ChevronRight, Globe, User } from "lucide-react"
import { BotAvatar } from "./bot-avatar"
import { BotDetail } from "./bot-detail"
import { BotTraitsPicker } from "./bot-traits-picker"
import { useCachedWorkspaceBootstrap, workspaceKeys } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { useWorkspaceBots } from "@/stores/workspace-store"

interface BotsTabProps {
  workspaceId: string
}

export function BotsTab({ workspaceId }: BotsTabProps) {
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)

  if (selectedBotId) {
    return <BotDetail workspaceId={workspaceId} botId={selectedBotId} onBack={() => setSelectedBotId(null)} />
  }

  return <BotList workspaceId={workspaceId} onSelectBot={setSelectedBotId} />
}

function BotList({ workspaceId, onSelectBot }: { workspaceId: string; onSelectBot: (id: string) => void }) {
  const queryClient = useQueryClient()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const allCachedBots = useWorkspaceBots(workspaceId)

  const canManageShared = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE)
  const canCreateShared = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_SHARED)
  const canCreatePersonal = hasPermission(
    bootstrap?.viewerPermissions,
    WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_PERSONAL
  )

  const showSharedSection = canManageShared || canCreateShared
  const showPersonalSection = canCreatePersonal

  const sharedBotsQueryKey = ["bots", workspaceId, "shared"]
  const { data: sharedBots = [], isLoading: sharedLoading } = useQuery({
    queryKey: sharedBotsQueryKey,
    queryFn: () => botsApi.list(workspaceId),
    enabled: showSharedSection,
    refetchOnMount: "always",
  })

  // Personal bots come from the bootstrap-synced IDB cache filtered by type.
  const personalBots = allCachedBots.filter((b) => b.type === "personal" && !b.archivedAt)

  // Single discriminant prevents both forms from being open simultaneously,
  // which would produce duplicate element IDs in the DOM.
  const [activeCreateForm, setActiveCreateForm] = useState<"shared" | "personal" | null>(null)

  const sharedCreateMutation = useMutation({
    mutationFn: (data: CreateBotInput) => botsApi.create(workspaceId, { ...data, type: "shared" }),
    onSuccess: (bot) => {
      setActiveCreateForm(null)
      queryClient.invalidateQueries({ queryKey: sharedBotsQueryKey })
      onSelectBot(bot.id)
    },
  })

  const personalCreateMutation = useMutation({
    mutationFn: (data: CreateBotInput) => botsApi.create(workspaceId, { ...data, type: "personal" }),
    onSuccess: (bot) => {
      setActiveCreateForm(null)
      queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
      onSelectBot(bot.id)
    },
  })

  if (showSharedSection && sharedLoading) {
    return (
      <div className="space-y-6 p-1">
        <div className="space-y-3">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-[52px] w-full rounded-lg" />
          <Skeleton className="h-[52px] w-full rounded-lg" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-1">
      {showSharedSection && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <h3 className="text-sm font-medium truncate">Workspace bots</h3>
              <Badge variant="secondary" className="text-[11px] px-1.5 py-0 h-4 font-normal tabular-nums shrink-0">
                {sharedBots.length}
              </Badge>
            </div>
            {activeCreateForm !== "shared" && canCreateShared && (
              <Button size="sm" className="shrink-0" onClick={() => setActiveCreateForm("shared")}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                New bot
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground -mt-1">
            Shared integration identities managed by workspace admins.
          </p>

          {activeCreateForm === "shared" && (
            <CreateBotForm
              placeholder="e.g. GitHub Bot, Deploy Notifier"
              isPending={sharedCreateMutation.isPending}
              error={sharedCreateMutation.error}
              onCancel={() => setActiveCreateForm(null)}
              onCreate={(data) => sharedCreateMutation.mutate(data)}
            />
          )}

          {sharedBots.length > 0 ? (
            <BotListItems bots={sharedBots} workspaceId={workspaceId} onSelectBot={onSelectBot} />
          ) : (
            activeCreateForm !== "shared" && (
              <EmptyBotsState
                label="No workspace bots yet"
                description="Create a shared bot to post messages via the API."
                action={
                  canCreateShared
                    ? { label: "Create workspace bot", onClick: () => setActiveCreateForm("shared") }
                    : undefined
                }
              />
            )
          )}
        </section>
      )}

      {showSharedSection && showPersonalSection && <Separator />}

      {showPersonalSection && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <h3 className="text-sm font-medium truncate">My bots</h3>
              <Badge variant="secondary" className="text-[11px] px-1.5 py-0 h-4 font-normal tabular-nums shrink-0">
                {personalBots.length}
              </Badge>
            </div>
            {activeCreateForm !== "personal" && (
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => setActiveCreateForm("personal")}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                New bot
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground -mt-1">Personal bots you own and manage independently.</p>

          {activeCreateForm === "personal" && (
            <CreateBotForm
              placeholder="e.g. OpenClaw, Hermes"
              isPending={personalCreateMutation.isPending}
              error={personalCreateMutation.error}
              onCancel={() => setActiveCreateForm(null)}
              onCreate={(data) => personalCreateMutation.mutate(data)}
            />
          )}

          {personalBots.length > 0 ? (
            <BotListItems bots={personalBots} workspaceId={workspaceId} onSelectBot={onSelectBot} />
          ) : (
            activeCreateForm !== "personal" && (
              <EmptyBotsState
                label="No personal bots yet"
                description="Create a personal bot to use with your own API keys and scratchpads."
                action={{ label: "Create personal bot", onClick: () => setActiveCreateForm("personal") }}
              />
            )
          )}
        </section>
      )}

      {!showSharedSection && !showPersonalSection && (
        <EmptyBotsState label="No access" description="You don't have permission to create or manage bots." />
      )}
    </div>
  )
}

interface CreateBotFormProps {
  placeholder: string
  isPending: boolean
  error: Error | null
  onCancel: () => void
  onCreate: (data: Omit<CreateBotInput, "type">) => void
}

function CreateBotForm({ placeholder, isPending, error, onCancel, onCreate }: CreateBotFormProps) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [description, setDescription] = useState("")
  const [traits, setTraits] = useState<Set<BotTrait>>(() => new Set())
  const [slugTouched, setSlugTouched] = useState(false)

  const handleNameChange = (value: string) => {
    setName(value)
    if (!slugTouched) {
      setSlug(
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
      )
    }
  }

  const canSubmit = name.trim().length > 0 && slug.trim().length > 0 && !isPending

  const toggleTrait = (trait: BotTrait) => {
    setTraits((current) => {
      const next = new Set(current)
      if (next.has(trait)) next.delete(trait)
      else next.add(trait)
      return next
    })
  }

  const handleCreate = () => {
    if (!canSubmit) return
    onCreate({
      name: name.trim(),
      slug: slug.trim(),
      description: description.trim() || null,
      traits: Array.from(traits),
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCreate()
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4" onKeyDown={handleKeyDown}>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="bot-name" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Name
          </Label>
          <Input
            id="bot-name"
            placeholder={placeholder}
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-slug" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Slug
          </Label>
          <Input
            id="bot-slug"
            placeholder="my-bot"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(e.target.value)
            }}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Slug is the unique identifier — lowercase letters, numbers, and hyphens.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="bot-description" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Description <span className="normal-case font-normal">(optional)</span>
        </Label>
        <Textarea
          id="bot-description"
          placeholder="What does this bot do?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </div>

      <BotTraitsPicker traits={traits} onToggle={toggleTrait} />

      <div className="flex items-center justify-between pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          {error && (
            <p className="text-xs text-destructive">
              {error instanceof Error ? error.message : "Failed to create bot."}
            </p>
          )}
          <Button size="sm" onClick={handleCreate} disabled={!canSubmit}>
            {isPending ? "Creating..." : "Create bot"}
          </Button>
        </div>
      </div>
    </div>
  )
}

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
  onSelectBot,
}: {
  bots: BotListItem[]
  workspaceId: string
  onSelectBot: (id: string) => void
}) {
  return (
    <div className="rounded-lg border divide-y overflow-hidden">
      {bots.map((bot) => (
        <button
          key={bot.id}
          className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors text-left group"
          onClick={() => onSelectBot(bot.id)}
        >
          <BotAvatar bot={bot} workspaceId={workspaceId} size={32} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-medium truncate">{bot.name}</span>
              {bot.slug && (
                <code className="text-[11px] text-muted-foreground/60 font-mono hidden sm:inline shrink-0">
                  @{bot.slug}
                </code>
              )}
            </div>
            {bot.description && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate leading-snug">{bot.description}</p>
            )}
          </div>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0 group-hover:text-muted-foreground/70 transition-colors" />
        </button>
      ))}
    </div>
  )
}

interface EmptyBotsStateProps {
  label: string
  description?: string
  action?: { label: string; onClick: () => void }
}

function EmptyBotsState({ label, description, action }: EmptyBotsStateProps) {
  return (
    <div className="rounded-lg border border-dashed py-8 flex flex-col items-center gap-1.5 text-center px-6">
      <BotIcon className="h-5 w-5 text-muted-foreground/40 mb-0.5" />
      <p className="text-sm font-medium text-foreground/70">{label}</p>
      {description && <p className="text-xs text-muted-foreground max-w-[260px]">{description}</p>}
      {action && (
        <Button variant="ghost" size="sm" className="mt-2 h-7 text-xs" onClick={action.onClick}>
          <Plus className="h-3 w-3 mr-1" />
          {action.label}
        </Button>
      )}
    </div>
  )
}
