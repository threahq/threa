import { useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { useUploadAvatar, useRemoveAvatar } from "@/hooks"
import { getAvatarUrl } from "@threahq/types"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { SETTING_CONTROL_HEIGHT } from "./setting-primitives"
import { toast } from "sonner"

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB

interface AvatarSectionProps {
  workspaceId: string
  userName: string
  avatarUrl: string | null
}

export function AvatarSection({ workspaceId, userName, avatarUrl }: AvatarSectionProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const uploadAvatar = useUploadAvatar(workspaceId)
  const removeAvatar = useRemoveAvatar(workspaceId)

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Reset input so the same file can be re-selected
    e.target.value = ""

    if (file.size > MAX_FILE_SIZE) {
      toast.error("File too large. Maximum size is 50MB.")
      return
    }

    setUploading(true)
    try {
      await uploadAvatar.mutateAsync(file)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload avatar")
    } finally {
      setUploading(false)
    }
  }

  const handleRemove = async () => {
    try {
      await removeAvatar.mutateAsync()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove avatar")
    }
  }

  const imageUrl = getAvatarUrl(workspaceId, avatarUrl, 256)

  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0">
        <Avatar className="h-16 w-16">
          {imageUrl && <AvatarImage src={imageUrl} alt="" />}
          <AvatarFallback className="text-lg">{getInitials(userName)}</AvatarFallback>
        </Avatar>
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-background/60">
            <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-wrap gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          tabIndex={-1}
          onChange={handleFileChange}
        />
        <Button
          variant="outline"
          size="sm"
          className={cn("flex-1", SETTING_CONTROL_HEIGHT)}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-busy={uploading}
        >
          {uploading ? "Uploading…" : "Change photo"}
        </Button>
        {avatarUrl && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            disabled={uploading || removeAvatar.isPending}
            className={cn("text-muted-foreground", SETTING_CONTROL_HEIGHT)}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  )
}
