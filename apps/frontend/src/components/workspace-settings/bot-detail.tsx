import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { botsApi } from "@/api/bots"
import type { BotTrait } from "@threa/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
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
import { ArrowLeft, Archive, ArchiveRestore, Upload, X } from "lucide-react"
import { BotAvatar } from "./bot-avatar"
import { BotKeysSection } from "./bot-keys-section"
import { BotChannelsSection } from "./bot-channels-section"
import { BotTraitsPicker } from "./bot-traits-picker"

interface BotDetailProps {
  workspaceId: string
  botId: string
  onBack: () => void
}

export function BotDetail({ workspaceId, botId, onBack }: BotDetailProps) {
  const queryClient = useQueryClient()
  const botQueryKey = ["bots", workspaceId, botId]

  const { data: bot, isLoading } = useQuery({
    queryKey: botQueryKey,
    queryFn: () => botsApi.get(workspaceId, botId),
  })

  // Profile editing
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState("")
  const [editSlug, setEditSlug] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [editTraits, setEditTraits] = useState<Set<BotTrait>>(() => new Set())
  const [archiveTarget, setArchiveTarget] = useState(false)

  const updateMutation = useMutation({
    mutationFn: (data: { name?: string; slug?: string; description?: string | null; traits?: BotTrait[] }) =>
      botsApi.update(workspaceId, botId, data),
    onSuccess: () => {
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: botQueryKey })
      queryClient.invalidateQueries({ queryKey: ["bots", workspaceId] })
    },
  })

  const archiveMutation = useMutation({
    mutationFn: () => botsApi.archive(workspaceId, botId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bots", workspaceId] })
      onBack()
    },
  })

  const restoreMutation = useMutation({
    mutationFn: () => botsApi.restore(workspaceId, botId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: botQueryKey })
      queryClient.invalidateQueries({ queryKey: ["bots", workspaceId] })
    },
  })

  // Avatar upload
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const uploadAvatarMutation = useMutation({
    mutationFn: (file: File) => botsApi.uploadAvatar(workspaceId, botId, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: botQueryKey })
      queryClient.invalidateQueries({ queryKey: ["bots", workspaceId] })
    },
  })
  const removeAvatarMutation = useMutation({
    mutationFn: () => botsApi.removeAvatar(workspaceId, botId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: botQueryKey })
      queryClient.invalidateQueries({ queryKey: ["bots", workspaceId] })
    },
  })

  const startEditing = () => {
    if (!bot) return
    setEditName(bot.name)
    setEditSlug(bot.slug ?? "")
    setEditDescription(bot.description ?? "")
    setEditTraits(new Set(bot.traits))
    setEditing(true)
  }

  const toggleEditTrait = (trait: BotTrait) => {
    setEditTraits((current) => {
      const next = new Set(current)
      if (next.has(trait)) next.delete(trait)
      else next.add(trait)
      return next
    })
  }

  const handleSave = () => {
    if (!editName.trim() || !editSlug.trim()) return
    updateMutation.mutate({
      name: editName.trim(),
      slug: editSlug.trim(),
      description: editDescription.trim() || null,
      traits: Array.from(editTraits),
    })
  }

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) uploadAvatarMutation.mutate(file)
    e.target.value = ""
  }

  if (isLoading) {
    return (
      <div className="space-y-3 p-1">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }

  if (!bot) {
    return (
      <div className="p-1">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
          Back
        </Button>
        <p className="text-sm text-muted-foreground mt-4">Bot not found.</p>
      </div>
    )
  }

  const isArchived = !!bot.archivedAt

  return (
    <div className="space-y-6 p-1">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-7 px-2">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <BotAvatar bot={bot} workspaceId={workspaceId} size={32} />
        <div>
          <h3 className="text-sm font-medium">{bot.name}</h3>
          {bot.slug && <p className="text-xs text-muted-foreground">@{bot.slug}</p>}
        </div>
        {isArchived && (
          <Badge variant="secondary" className="ml-auto text-xs">
            Archived
          </Badge>
        )}
      </div>

      {/* Profile */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Profile</h4>
          {!isArchived && !editing && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={startEditing}>
              Edit
            </Button>
          )}
        </div>

        {/* Avatar upload */}
        {!isArchived && (
          <div className="flex items-center gap-3">
            <BotAvatar bot={bot} workspaceId={workspaceId} size={56} />
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={uploadAvatarMutation.isPending}
                >
                  <Upload className="h-3 w-3 mr-1" />
                  {uploadAvatarMutation.isPending ? "Uploading..." : "Upload image"}
                </Button>
                {bot.avatarUrl && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground"
                    onClick={() => removeAvatarMutation.mutate()}
                    disabled={removeAvatarMutation.isPending}
                  >
                    <X className="h-3 w-3 mr-1" />
                    Remove
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">JPEG, PNG, or WebP. Max 50MB.</p>
              {uploadAvatarMutation.error && (
                <p className="text-xs text-destructive">
                  {uploadAvatarMutation.error instanceof Error ? uploadAvatarMutation.error.message : "Upload failed."}
                </p>
              )}
            </div>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleAvatarChange}
            />
          </div>
        )}

        {editing ? (
          <div className="rounded-lg border bg-card p-4 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Slug</Label>
              <Input value={editSlug} onChange={(e) => setEditSlug(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Description</Label>
              <Textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={2} />
            </div>
            <BotTraitsPicker traits={editTraits} onToggle={toggleEditTrait} />
            <div className="flex items-center justify-between pt-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!editName.trim() || !editSlug.trim() || updateMutation.isPending}
              >
                {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
            {updateMutation.error && (
              <p className="text-sm text-destructive">
                {updateMutation.error instanceof Error ? updateMutation.error.message : "Failed to save."}
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-md border px-3 py-2.5 space-y-1.5">
            <div className="flex items-baseline gap-2">
              <p className="text-sm font-medium">{bot.name}</p>
              {bot.slug && <span className="text-xs text-muted-foreground font-mono">@{bot.slug}</span>}
            </div>
            {bot.description && <p className="text-xs text-muted-foreground">{bot.description}</p>}
            {!bot.description && <p className="text-xs text-muted-foreground italic">No description</p>}
            <div className="flex flex-wrap gap-1 pt-1">
              {bot.traits.length > 0 ? (
                bot.traits.map((trait) => (
                  <Badge key={trait} variant="secondary" className="text-[11px] font-normal">
                    {trait}
                  </Badge>
                ))
              ) : (
                <Badge variant="outline" className="text-[11px] font-normal text-muted-foreground">
                  no capabilities
                </Badge>
              )}
            </div>
          </div>
        )}
      </section>

      <Separator />
      <BotKeysSection workspaceId={workspaceId} botId={botId} isArchived={isArchived} />
      <Separator />
      <BotChannelsSection workspaceId={workspaceId} botId={botId} isArchived={isArchived} />
      <Separator />

      {/* Danger zone */}
      <section className="space-y-3">
        <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Danger zone</h4>
        {isArchived ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => restoreMutation.mutate()}
            disabled={restoreMutation.isPending}
          >
            <ArchiveRestore className="h-3.5 w-3.5 mr-1.5" />
            {restoreMutation.isPending ? "Restoring..." : "Restore bot"}
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="text-destructive" onClick={() => setArchiveTarget(true)}>
            <Archive className="h-3.5 w-3.5 mr-1.5" />
            Archive bot
          </Button>
        )}
      </section>

      {/* Archive confirmation */}
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
              {archiveMutation.isPending ? "Archiving..." : "Archive bot"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
