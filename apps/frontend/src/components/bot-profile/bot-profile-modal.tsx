import { Link, useLocation, useParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Eye, Sparkles, Settings } from "lucide-react"
import type { BotProfile, BotProfileStream, BotRuntimeKind, BotRuntimeStatus } from "@threahq/types"
import { botsApi } from "@/api/bots"
import { ApiError } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { RelativeTime } from "@/components/relative-time"
import { useStreamName } from "@/hooks/use-stream-name"
import { BotAvatar } from "@/components/workspace-settings/bot-avatar"
import { BOT_TRAIT_LABELS } from "@/components/workspace-settings/bot-traits-picker"
import { WS_SETTINGS_BOT_PARAM, WS_SETTINGS_PARAM } from "@/components/workspace-settings/tab-config"
import { streamChipParts, streamLabel } from "@/lib/streams"
import { cn } from "@/lib/utils"
import { useWorkspaceUsers } from "@/stores/workspace-store"

const RUNTIME_KIND_LABELS: Record<BotRuntimeKind, string> = {
  "pi-local": "Pi",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  "claude-code-channel": "Claude Code",
  custom: "Custom runtime",
}

const RUNTIME_STATUS: Record<BotRuntimeStatus, { label: string; dotClassName: string }> = {
  available: { label: "Available", dotClassName: "bg-emerald-500" },
  busy: { label: "Busy", dotClassName: "bg-amber-500" },
  offline: { label: "Offline", dotClassName: "bg-muted-foreground/40" },
  error: { label: "Error", dotClassName: "bg-destructive" },
}

interface BotProfileModalProps {
  botId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenUserProfile: (userId: string) => void
}

export function BotProfileModal({ botId, open, onOpenChange, onOpenUserProfile }: BotProfileModalProps) {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>()
  const { data, error, isLoading } = useQuery({
    queryKey: ["bots", workspaceId, botId, "profile"],
    queryFn: () => botsApi.getProfile(workspaceId, botId),
    enabled: Boolean(workspaceId),
  })

  let body = <BotProfileSkeleton />
  if (data) {
    body = (
      <BotProfileDetails
        workspaceId={workspaceId}
        profile={data}
        onClose={() => onOpenChange(false)}
        onOpenUserProfile={onOpenUserProfile}
      />
    )
  } else if (error || !isLoading) {
    body = (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {error instanceof ApiError && error.status === 404 ? "This bot isn't available." : "Couldn't load this bot."}
      </p>
    )
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="sr-only">Bot profile</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            {data ? `Profile for ${data.bot.name}` : "Bot profile"}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4 pb-6">{body}</ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function BotProfileSkeleton() {
  return (
    <div data-testid="bot-profile-skeleton" className="space-y-4">
      <div className="flex flex-col items-center gap-3 pt-2">
        <Skeleton className="h-24 w-24 rounded-full" />
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-20" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  )
}

interface BotProfileDetailsProps {
  workspaceId: string
  profile: BotProfile
  onClose: () => void
  onOpenUserProfile: (userId: string) => void
}

function BotProfileDetails({ workspaceId, profile, onClose, onOpenUserProfile }: BotProfileDetailsProps) {
  const { bot, runtime, streams, canManage } = profile
  const location = useLocation()
  const users = useWorkspaceUsers(workspaceId)
  const ownerName = bot.ownerUserId ? (users.find((u) => u.id === bot.ownerUserId)?.name ?? "its owner") : null

  const manageParams = new URLSearchParams(location.search)
  manageParams.set(WS_SETTINGS_PARAM, "bots")
  manageParams.set(WS_SETTINGS_BOT_PARAM, bot.id)

  // Only the owner learns a personal bot reads through them; bot settings promise members never see that.
  const showReadAccess = bot.type === "shared" || canManage
  const readsEverything = bot.type === "personal" && bot.readsAsOwner
  const runtimeStatus = runtime ? RUNTIME_STATUS[runtime.status] : null

  return (
    <>
      <div className="flex flex-col items-center gap-3 pt-2">
        <BotAvatar bot={bot} workspaceId={workspaceId} size={96} />
        <div className="text-center">
          <h2 className="text-xl font-semibold">{bot.name}</h2>
          <p className="text-sm text-muted-foreground">@{bot.slug}</p>
          <div className="mt-1 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
            <Badge variant="secondary">{bot.type === "personal" ? "Personal" : "Shared"}</Badge>
            {bot.type === "personal" && bot.ownerUserId && (
              <>
                <span>owned by</span>
                <button
                  type="button"
                  onClick={() => onOpenUserProfile(bot.ownerUserId)}
                  className="font-medium text-foreground hover:underline"
                >
                  {ownerName}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {bot.description && <p className="text-sm text-center text-muted-foreground">{bot.description}</p>}

      <Separator />
      <div className="space-y-2.5 text-sm">
        {showReadAccess && (
          <div className="flex items-start gap-2.5">
            <Eye className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              {readsEverything
                ? "Reads everything you can read, except end-to-end encrypted streams"
                : "Reads only the streams it's added to"}
            </span>
          </div>
        )}
        {bot.traits.length > 0 && (
          <div className="flex items-center gap-2.5">
            <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-wrap gap-1.5">
              {bot.traits.map((trait) => (
                <Badge key={trait} variant="outline" className="font-normal">
                  {BOT_TRAIT_LABELS[trait]}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {runtime && runtimeStatus && (
          <div className="flex items-center gap-2.5">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <span className={cn("h-2 w-2 rounded-full", runtimeStatus.dotClassName)} />
            </span>
            <span>
              {runtimeStatus.label}
              <span className="text-muted-foreground">
                {" · "}
                {RUNTIME_KIND_LABELS[runtime.runtimeKind as BotRuntimeKind] ?? runtime.runtimeKind}
                {" · seen "}
                <RelativeTime date={runtime.lastSeenAt} />
              </span>
            </span>
          </div>
        )}
      </div>

      {streams.length > 0 && (
        <>
          <Separator />
          <ul className="flex flex-wrap gap-1.5" aria-label="Streams">
            {streams.map((stream) => (
              <BotStreamLink key={stream.id} workspaceId={workspaceId} stream={stream} onClose={onClose} />
            ))}
          </ul>
        </>
      )}

      {canManage && (
        <>
          <Separator />
          <Link
            to={{ pathname: location.pathname, search: `?${manageParams.toString()}` }}
            onClick={onClose}
            className={buttonVariants({ variant: "outline", className: "w-full" })}
          >
            <Settings className="h-4 w-4 mr-2" />
            Manage
          </Link>
        </>
      )}
    </>
  )
}

interface BotStreamLinkProps {
  workspaceId: string
  stream: BotProfileStream
  onClose: () => void
}

function BotStreamLink({ workspaceId, stream, onClose }: BotStreamLinkProps) {
  const name = useStreamName(workspaceId, stream.id) ?? streamLabel(stream)
  const { icon: Icon, label, prefix } = streamChipParts(stream.type, name)
  return (
    <li className="min-w-0">
      <Link
        to={`/w/${workspaceId}/s/${stream.id}`}
        onClick={onClose}
        className="flex min-w-0 items-center gap-1 rounded-md border px-2 py-1 text-sm hover:bg-accent/50"
      >
        {prefix ? (
          <span className="text-muted-foreground">{prefix}</span>
        ) : (
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{label}</span>
      </Link>
    </li>
  )
}
