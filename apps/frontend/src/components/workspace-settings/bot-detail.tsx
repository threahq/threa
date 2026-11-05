import { useId, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { botsApi } from "@/api/bots"
import type { BotTrait } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ArrowLeft, Archive, ArchiveRestore, Upload } from "lucide-react"
import {
  SETTING_CONTROL_HEIGHT,
  SettingActions,
  SettingFieldError,
  SettingRow,
  settingIds,
  SettingBadge,
} from "@/components/settings/setting-primitives"
import { SETTING_ICON_BUTTON, SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"
import { cn } from "@/lib/utils"
import { BotAvatar } from "./bot-avatar"
import { BotKeysSection } from "./bot-keys-section"
import { BotChannelsSection } from "./bot-channels-section"
import { BotWebhooksSection } from "./bot-webhooks-section"
import { BOT_TRAIT_LABELS } from "./bot-traits-picker"
import { BotProfileDialog } from "./bot-profile-dialog"

interface BotDetailProps {
  workspaceId: string
  botId: string
  onBack: () => void
}

export function BotDetail({ workspaceId, botId, onBack }: BotDetailProps) {
  const queryClient = useQueryClient()
  const readsAsOwnerAnchor = useId()
  const readsAsOwnerIds = settingIds(readsAsOwnerAnchor)
  const { data: bot, isLoading } = useQuery({
    queryKey: ["bots", workspaceId, botId],
    queryFn: () => botsApi.get(workspaceId, botId),
  })
  // The prefix covers this bot's own query and every bot list.
  const invalidateBots = () => void queryClient.invalidateQueries({ queryKey: ["bots", workspaceId] })

  const [editing, setEditing] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState(false)

  const updateMutation = useMutation({
    mutationFn: (data: { name?: string; slug?: string; description?: string | null; traits?: BotTrait[] }) =>
      botsApi.update(workspaceId, botId, data),
    onSuccess: () => {
      setEditing(false)
      invalidateBots()
    },
  })

  const readsAsOwnerMutation = useMutation({
    mutationFn: (readsAsOwner: boolean) => botsApi.update(workspaceId, botId, { readsAsOwner }),
    onSuccess: invalidateBots,
  })

  const archiveMutation = useMutation({
    mutationFn: () => botsApi.archive(workspaceId, botId),
    onSuccess: () => {
      invalidateBots()
      onBack()
    },
  })

  const restoreMutation = useMutation({
    mutationFn: () => botsApi.restore(workspaceId, botId),
    onSuccess: invalidateBots,
  })

  const avatarInputRef = useRef<HTMLInputElement>(null)
  const uploadAvatarMutation = useMutation({
    mutationFn: (file: File) => botsApi.uploadAvatar(workspaceId, botId, file),
    onSuccess: invalidateBots,
  })
  const removeAvatarMutation = useMutation({
    mutationFn: () => botsApi.removeAvatar(workspaceId, botId),
    onSuccess: invalidateBots,
  })

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) uploadAvatarMutation.mutate(file)
    e.target.value = ""
  }

  const backButton = (
    <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to bots" className={SETTING_ICON_BUTTON}>
      <ArrowLeft aria-hidden />
    </Button>
  )

  if (isLoading) {
    return (
      <div className="space-y-3 px-4 py-3" aria-hidden>
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (!bot) {
    return (
      <div className="flex items-center gap-2 px-4 py-3">
        {backButton}
        <p className={SETTING_MUTED_NOTE_TEXT}>Bot not found.</p>
      </div>
    )
  }

  const isArchived = !!bot.archivedAt
  const errorText = (error: Error | null, fallback: string) => error?.message || fallback

  return (
    <>
      <div className="flex min-h-11 items-center gap-2 px-4 py-3 first:rounded-t-lg">
        {backButton}
        <BotAvatar bot={bot} workspaceId={workspaceId} size={32} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{bot.name}</h3>
          {bot.slug && <p className={SETTING_MUTED_NOTE_TEXT}>@{bot.slug}</p>}
        </div>
        {isArchived && <SettingBadge>Archived</SettingBadge>}
      </div>

      {!isArchived && (
        <SettingRow
          label="Picture"
          description="JPEG, PNG, or WebP. Max 50MB."
          control={
            <SettingActions>
              <Button
                variant="outline"
                size="sm"
                className={SETTING_CONTROL_HEIGHT}
                onClick={() => avatarInputRef.current?.click()}
                disabled={uploadAvatarMutation.isPending}
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {uploadAvatarMutation.isPending ? "Uploading…" : "Upload image"}
              </Button>
              {bot.avatarUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={SETTING_CONTROL_HEIGHT}
                  onClick={() => removeAvatarMutation.mutate()}
                  disabled={removeAvatarMutation.isPending}
                >
                  Remove
                </Button>
              )}
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </SettingActions>
          }
        >
          {(uploadAvatarMutation.error || removeAvatarMutation.error) && (
            <SettingFieldError>
              {uploadAvatarMutation.error
                ? errorText(uploadAvatarMutation.error, "Upload failed.")
                : errorText(removeAvatarMutation.error, "Couldn't remove the picture.")}
            </SettingFieldError>
          )}
        </SettingRow>
      )}

      <SettingRow
        label="Profile"
        description={bot.description ?? "No description."}
        control={
          !isArchived && (
            <Button variant="outline" size="sm" className={SETTING_CONTROL_HEIGHT} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {bot.traits.length > 0 ? (
            bot.traits.map((trait) => <SettingBadge key={trait}>{BOT_TRAIT_LABELS[trait]}</SettingBadge>)
          ) : (
            <span className={SETTING_MUTED_NOTE_TEXT}>No capabilities.</span>
          )}
        </div>
      </SettingRow>

      <BotKeysSection workspaceId={workspaceId} botId={botId} isArchived={isArchived} />
      <BotChannelsSection workspaceId={workspaceId} botId={botId} isArchived={isArchived} />
      <BotWebhooksSection
        key={`${workspaceId}:${botId}`}
        workspaceId={workspaceId}
        botId={botId}
        isArchived={isArchived}
      />

      {bot.type === "personal" && (
        <SettingRow
          label="Read everything you can read"
          anchor={readsAsOwnerAnchor}
          toggle
          description="Except end-to-end encrypted streams. The bot can still only post where it has been added, and other members see which streams it was added to, not that it reads through you."
          control={
            <Switch
              id={readsAsOwnerIds.control}
              aria-labelledby={readsAsOwnerIds.label}
              aria-describedby={readsAsOwnerIds.description}
              checked={bot.readsAsOwner}
              disabled={isArchived || readsAsOwnerMutation.isPending}
              onCheckedChange={(checked) => readsAsOwnerMutation.mutate(checked)}
            />
          }
        >
          {readsAsOwnerMutation.error && (
            <SettingFieldError>{errorText(readsAsOwnerMutation.error, "Couldn't update.")}</SettingFieldError>
          )}
        </SettingRow>
      )}

      <SettingRow
        label={isArchived ? "Restore bot" : "Archive bot"}
        description={
          isArchived
            ? "Brings the bot back. Its old API keys stay revoked."
            : "Revokes all its API keys. Its messages stay visible, and you can restore it later."
        }
        control={
          isArchived ? (
            <Button
              variant="outline"
              size="sm"
              className={SETTING_CONTROL_HEIGHT}
              onClick={() => restoreMutation.mutate()}
              disabled={restoreMutation.isPending}
            >
              <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {restoreMutation.isPending ? "Restoring…" : "Restore"}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className={cn("text-destructive hover:text-destructive", SETTING_CONTROL_HEIGHT)}
              onClick={() => setArchiveTarget(true)}
            >
              <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Archive
            </Button>
          )
        }
      >
        {(archiveMutation.error || restoreMutation.error) && (
          <SettingFieldError>
            {archiveMutation.error
              ? errorText(archiveMutation.error, "Couldn't archive the bot.")
              : errorText(restoreMutation.error, "Couldn't restore the bot.")}
          </SettingFieldError>
        )}
      </SettingRow>

      <BotProfileDialog
        mode="edit"
        open={editing}
        onClose={() => {
          setEditing(false)
          updateMutation.reset()
        }}
        initial={{ name: bot.name, slug: bot.slug ?? "", description: bot.description, traits: bot.traits }}
        isPending={updateMutation.isPending}
        error={updateMutation.error}
        onSubmit={(values) => updateMutation.mutate(values)}
      />

      <AlertDialog open={archiveTarget} onOpenChange={(open) => !open && setArchiveTarget(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive bot</AlertDialogTitle>
            <AlertDialogDescription>
              This will archive <strong className="text-foreground">{bot.name}</strong> and revoke all its API keys.
              Existing messages from this bot will remain visible. You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => archiveMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {archiveMutation.isPending ? "Archiving…" : "Archive bot"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
