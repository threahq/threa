import { useState, useCallback, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Hash, Loader2 } from "lucide-react"
import { ChannelSlugInput } from "@/components/stream-settings/channel-slug-input"
import { VisibilityPicker } from "@/components/ui/visibility-picker"
import { UserPicker } from "./user-picker"
import { useCreateChannel } from "./use-create-channel"
import { useCreateStream } from "@/hooks"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { useAuth } from "@/auth"
import { toast } from "sonner"
import type { Visibility } from "@threahq/types"

function ChannelDialogHeader() {
  return (
    <div className="px-4 sm:px-6 pt-4 sm:pt-6 pb-4">
      <ResponsiveDialogHeader>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-primary/10">
            <Hash className="h-4.5 w-4.5 text-primary" />
          </div>
          <div>
            <ResponsiveDialogTitle className="text-base">Create a channel</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="text-xs mt-0.5">
              Channels organize conversations around a topic
            </ResponsiveDialogDescription>
          </div>
        </div>
      </ResponsiveDialogHeader>
    </div>
  )
}

function SlugField({
  workspaceId,
  value,
  onChange,
  onValidityChange,
}: {
  workspaceId: string
  value: string
  onChange: (v: string) => void
  onValidityChange: (valid: boolean) => void
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Name</Label>
      <ChannelSlugInput
        workspaceId={workspaceId}
        value={value}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />
    </div>
  )
}

function VisibilityField({ value, onChange }: { value: Visibility; onChange: (v: Visibility) => void }) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Visibility</Label>
      <VisibilityPicker value={value} onChange={onChange} />
    </div>
  )
}

function DescriptionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <Label className="text-sm font-medium">Description</Label>
        <span className="text-[11px] text-muted-foreground tabular-nums">{value.length}/500</span>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, 500))}
        placeholder="What is this channel about?"
        rows={2}
        className="resize-none text-sm"
      />
    </div>
  )
}

function DialogActions({
  onCancel,
  onSubmit,
  canSubmit,
  isPending,
}: {
  onCancel: () => void
  onSubmit: () => void
  canSubmit: boolean
  isPending: boolean
}) {
  return (
    <div className="border-t border-border px-4 sm:px-6 py-4 flex items-center justify-end gap-2 bg-muted/30">
      <Button variant="outline" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" onClick={onSubmit} disabled={!canSubmit} className="min-w-[120px]">
        {isPending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Creating...
          </>
        ) : (
          "Create Channel"
        )}
      </Button>
    </div>
  )
}

interface CreateChannelDialogProps {
  workspaceId: string
}

export function CreateChannelDialog({ workspaceId }: CreateChannelDialogProps) {
  const { isOpen, closeCreateChannel } = useCreateChannel()
  const { user } = useAuth()
  const navigate = useNavigate()
  const createStream = useCreateStream(workspaceId)
  const idbUsers = useWorkspaceUsers(workspaceId)

  const [slug, setSlug] = useState("")
  const [slugValid, setSlugValid] = useState(false)
  const [visibility, setVisibility] = useState<Visibility>("public")
  const [description, setDescription] = useState("")
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])

  const currentUserId = useMemo(() => {
    if (!user) return null
    return idbUsers.find((u) => u.workosUserId === user.id)?.id ?? null
  }, [idbUsers, user])

  const resetForm = useCallback(() => {
    setSlug("")
    setSlugValid(false)
    setVisibility("public")
    setDescription("")
    setSelectedUserIds([])
  }, [])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeCreateChannel()
        resetForm()
      }
    },
    [closeCreateChannel, resetForm]
  )

  const handleSubmit = useCallback(async () => {
    if (!slug || !slugValid) return

    try {
      const stream = await createStream.mutateAsync({
        type: "channel",
        slug,
        description: description || undefined,
        visibility,
        memberIds: selectedUserIds.length > 0 ? selectedUserIds : undefined,
      })
      closeCreateChannel()
      resetForm()
      navigate(`/w/${workspaceId}/s/${stream.id}`)
    } catch (error) {
      console.error("Failed to create channel:", error)
      toast.error("Failed to create channel")
    }
  }, [
    slug,
    slugValid,
    description,
    visibility,
    selectedUserIds,
    createStream,
    closeCreateChannel,
    resetForm,
    navigate,
    workspaceId,
  ])

  const canSubmit = slug.length > 0 && slugValid && !createStream.isPending

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-[480px] gap-0 p-0 overflow-hidden"
        drawerClassName="gap-0 p-0 overflow-hidden"
        hideCloseButton
      >
        <ChannelDialogHeader />
        <div className="border-t border-border" />
        <div className="px-4 sm:pl-6 sm:pr-4 py-5 space-y-5 sm:max-h-[60vh] flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          <SlugField workspaceId={workspaceId} value={slug} onChange={setSlug} onValidityChange={setSlugValid} />
          <VisibilityField value={visibility} onChange={setVisibility} />
          <DescriptionField value={description} onChange={setDescription} />
          {currentUserId && (
            <UserPicker
              workspaceId={workspaceId}
              currentUserId={currentUserId}
              selectedUserIds={selectedUserIds}
              onChange={setSelectedUserIds}
            />
          )}
        </div>
        <DialogActions
          onCancel={() => handleOpenChange(false)}
          onSubmit={handleSubmit}
          canSubmit={canSubmit}
          isPending={createStream.isPending}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
