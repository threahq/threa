import { useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { useUploadAvatar, useRemoveAvatar } from "@/hooks"
import { getAvatarUrl } from "@threahq/types"
import { getInitials } from "@/lib/initials"
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
      <div className="relative">
        <Avatar className="h-20 w-20">
          {imageUrl && <AvatarImage src={imageUrl} alt={userName} />}
          <AvatarFallback className="text-lg">{getInitials(userName)}</AvatarFallback>
        </Avatar>
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-background/60">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          Change photo
        </Button>
        {avatarUrl && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            disabled={uploading || removeAvatar.isPending}
            className="text-muted-foreground"
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  )
}
