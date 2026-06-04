import { useState } from "react"
import { useParams } from "react-router-dom"
import { CircleHelp, Smile } from "lucide-react"
import { resolveActiveStatus } from "@threa/types"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAuth } from "@/auth"
import { useUpdateProfile } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { StatusPicker } from "@/components/status/status-picker"
import { formatStatusClearLabel } from "@/lib/status"
import { AvatarSection } from "./avatar-section"
import { toast } from "sonner"

const PRONOUN_PRESETS = ["he/him", "she/her", "they/them", "xe/xem"] as const

function useCurrentUser(workspaceId: string): ReturnType<typeof useWorkspaceUsers>[number] | null {
  const { user } = useAuth()
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  if (!user) return null
  return workspaceUsers.find((u) => u.workosUserId === user.id) ?? null
}

export function ProfileSettings() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const currentUser = useCurrentUser(workspaceId!)
  const updateProfile = useUpdateProfile(workspaceId!)

  const [name, setName] = useState<string | null>(null)
  const [description, setDescription] = useState<string | null>(null)
  const [pronouns, setPronouns] = useState<string | null>(null)
  const [isCustomPronouns, setIsCustomPronouns] = useState(false)
  const [phone, setPhone] = useState<string | null>(null)
  const [githubUsername, setGithubUsername] = useState<string | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const { toEmoji } = useWorkspaceEmoji(workspaceId!)

  if (!currentUser) return null

  const activeStatus = resolveActiveStatus({
    statusEmoji: currentUser.statusEmoji ?? null,
    statusText: currentUser.statusText ?? null,
    statusExpiresAt: currentUser.statusExpiresAt ?? null,
  })
  const statusGlyph = activeStatus?.emoji ? toEmoji(activeStatus.emoji) : null
  const statusClearLabel = formatStatusClearLabel(activeStatus?.expiresAt ?? null)

  // Use local state if edited, otherwise show server value
  const currentName = name ?? currentUser.name
  const currentDescription = description ?? currentUser.description ?? ""
  const currentPronouns = pronouns ?? currentUser.pronouns ?? ""
  const currentPhone = phone ?? currentUser.phone ?? ""
  const currentGithub = githubUsername ?? currentUser.githubUsername ?? ""

  const nameChanged = name !== null && name !== currentUser.name
  const descriptionChanged = description !== null && (description || null) !== (currentUser.description || null)
  const pronounsChanged = pronouns !== null && (pronouns || null) !== (currentUser.pronouns || null)
  const phoneChanged = phone !== null && (phone || null) !== (currentUser.phone || null)
  const githubChanged = githubUsername !== null && (githubUsername || null) !== (currentUser.githubUsername || null)
  const nameValid = currentName.trim().length > 0

  // Determine if current pronouns value is a preset or custom
  const isPreset = PRONOUN_PRESETS.includes(currentPronouns as (typeof PRONOUN_PRESETS)[number])
  const showCustomInput = isCustomPronouns || (currentPronouns !== "" && !isPreset)
  const selectValue = showCustomInput ? "custom" : currentPronouns || "none"

  const handleSaveName = async () => {
    if (!nameChanged || !nameValid) return
    try {
      await updateProfile.mutateAsync({ name: currentName.trim() })
      setName(null)
      toast.success("Name updated")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update name")
    }
  }

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleSaveName()
    }
  }

  const handleSaveDescription = async () => {
    if (!descriptionChanged) return
    try {
      await updateProfile.mutateAsync({ description: currentDescription.trim() || null })
      setDescription(null)
      toast.success("Description updated")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update description")
    }
  }

  const handlePronounSelectChange = (value: string) => {
    if (value === "custom") {
      setIsCustomPronouns(true)
      if (!currentPronouns || isPreset) setPronouns("")
    } else if (value === "none") {
      setIsCustomPronouns(false)
      setPronouns("")
    } else {
      setIsCustomPronouns(false)
      setPronouns(value)
    }
  }

  const handleSavePronouns = async () => {
    if (!pronounsChanged) return
    try {
      await updateProfile.mutateAsync({ pronouns: currentPronouns.trim() || null })
      setPronouns(null)
      setIsCustomPronouns(false)
      toast.success("Pronouns updated")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update pronouns")
    }
  }

  const handleSavePhone = async () => {
    if (!phoneChanged) return
    try {
      await updateProfile.mutateAsync({ phone: currentPhone.trim() || null })
      setPhone(null)
      toast.success("Phone updated")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update phone")
    }
  }

  const handleSaveGithub = async () => {
    if (!githubChanged) return
    try {
      await updateProfile.mutateAsync({ githubUsername: currentGithub.trim() || null })
      setGithubUsername(null)
      toast.success("GitHub username updated")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update GitHub username")
    }
  }

  const handleFieldKeyDown = (save: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      save()
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-3">Photo</h3>
        <AvatarSection workspaceId={workspaceId!} userName={currentUser.name} avatarUrl={currentUser.avatarUrl} />
      </div>

      <div>
        <Label>Status</Label>
        <div className="mt-1.5">
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start gap-2 font-normal"
            onClick={() => setStatusOpen(true)}
          >
            {statusGlyph ? (
              <span className="text-base leading-none">{statusGlyph}</span>
            ) : (
              <Smile className="h-4 w-4 text-muted-foreground" />
            )}
            <span className={activeStatus ? "" : "text-muted-foreground"}>
              {activeStatus?.text || (statusGlyph ? "" : "Set a status")}
            </span>
          </Button>
          {statusClearLabel && <p className="mt-1 text-xs text-muted-foreground">{statusClearLabel}</p>}
        </div>
        {statusOpen && <StatusPicker workspaceId={workspaceId!} open onOpenChange={setStatusOpen} />}
      </div>

      <div>
        <Label htmlFor="profile-name">Display name</Label>
        <div className="flex gap-2 mt-1.5">
          <Input
            id="profile-name"
            value={currentName}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleNameKeyDown}
            maxLength={100}
            className="flex-1"
          />
          {nameChanged && (
            <Button size="sm" onClick={handleSaveName} disabled={!nameValid || updateProfile.isPending}>
              Save
            </Button>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-1.5">
          <Label htmlFor="profile-email">Email</Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <CircleHelp className="h-3.5 w-3.5 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-60">
              Your email is your identity in this workspace. To change it, update your account email.
            </TooltipContent>
          </Tooltip>
        </div>
        <Input id="profile-email" value={currentUser.email} disabled className="mt-1.5" />
      </div>

      <div>
        <Label>Pronouns</Label>
        <div className="flex gap-2 mt-1.5">
          <div className="flex-1 flex gap-2">
            <Select value={selectValue} onValueChange={handlePronounSelectChange}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {PRONOUN_PRESETS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            {showCustomInput && (
              <Input
                value={currentPronouns}
                onChange={(e) => setPronouns(e.target.value)}
                onKeyDown={handleFieldKeyDown(handleSavePronouns)}
                maxLength={50}
                placeholder="e.g. ze/zir"
                className="flex-1"
              />
            )}
          </div>
          {pronounsChanged && (
            <Button size="sm" onClick={handleSavePronouns} disabled={updateProfile.isPending}>
              Save
            </Button>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label htmlFor="profile-description">Description</Label>
          <span className="text-xs text-muted-foreground">{currentDescription.length}/500</span>
        </div>
        <div className="flex flex-col gap-2 mt-1.5">
          <Textarea
            id="profile-description"
            value={currentDescription}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="What do you do? A brief description."
            className="resize-none"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleSaveDescription}
              disabled={!descriptionChanged || updateProfile.isPending}
              className={descriptionChanged ? "" : "invisible"}
            >
              Save
            </Button>
          </div>
        </div>
      </div>

      <div>
        <Label htmlFor="profile-phone">Phone</Label>
        <div className="flex gap-2 mt-1.5">
          <Input
            id="profile-phone"
            value={currentPhone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={handleFieldKeyDown(handleSavePhone)}
            maxLength={30}
            placeholder="e.g. +1 555-0123"
            className="flex-1"
          />
          {phoneChanged && (
            <Button size="sm" onClick={handleSavePhone} disabled={updateProfile.isPending}>
              Save
            </Button>
          )}
        </div>
      </div>

      <div>
        <Label htmlFor="profile-github">GitHub</Label>
        <div className="flex gap-2 mt-1.5">
          <div className="flex flex-1 items-center">
            <span className="inline-flex h-9 items-center rounded-l-md border border-r-0 bg-muted px-3 text-sm text-muted-foreground">
              github.com/
            </span>
            <Input
              id="profile-github"
              value={currentGithub}
              onChange={(e) => setGithubUsername(e.target.value)}
              onKeyDown={handleFieldKeyDown(handleSaveGithub)}
              maxLength={39}
              placeholder="username"
              className="rounded-l-none flex-1"
            />
          </div>
          {githubChanged && (
            <Button size="sm" onClick={handleSaveGithub} disabled={updateProfile.isPending}>
              Save
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
