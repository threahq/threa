import { useEffect, useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import type { UpdateInvitationLinkInput, WorkspaceInvitation } from "@threahq/types"
import { invitationsApi } from "@/api/invitations"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import {
  InviteLinkSettingsFields,
  isoToLocalDateTime,
  localDateTimeToIso,
  validateInviteLinkSettings,
  type InviteLinkSettingsValue,
} from "./invite-link-settings-fields"

export function buildInviteLinkPatch(
  invitation: WorkspaceInvitation,
  value: InviteLinkSettingsValue
): UpdateInvitationLinkInput {
  const patch: UpdateInvitationLinkInput = {}
  if (invitation.role !== "admin") {
    const maxUses = value.unlimited ? null : Number(value.maxUses)
    if (maxUses !== invitation.maxUses) patch.maxUses = maxUses
  }

  const expiryControlsUnchanged =
    value.neverExpires === (invitation.expiresAt === null) &&
    value.expiresAt === isoToLocalDateTime(invitation.expiresAt)
  if (!expiryControlsUnchanged) patch.expiresAt = value.neverExpires ? null : localDateTimeToIso(value.expiresAt)
  return patch
}

export function EditInviteLinkDialog({
  workspaceId,
  invitation,
  open,
  onOpenChange,
  onSuccess,
}: {
  workspaceId: string
  invitation: WorkspaceInvitation | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [settings, setSettings] = useState<InviteLinkSettingsValue | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const openedInvitationRef = useRef<WorkspaceInvitation | null>(null)

  const mutation = useMutation({
    mutationFn: ({ invitationId, patch }: { invitationId: string; patch: UpdateInvitationLinkInput }) =>
      invitationsApi.updateLink(workspaceId, invitationId, patch),
  })

  useEffect(() => {
    if (!open) {
      generationRef.current += 1
      openedInvitationRef.current = null
      setSettings(null)
      setValidationError(null)
      mutation.reset()
      return
    }
    if (invitation && openedInvitationRef.current?.id !== invitation.id) {
      generationRef.current += 1
      openedInvitationRef.current = { ...invitation }
      const isLegacyAdminLink = invitation.role === "admin"
      setSettings({
        unlimited: isLegacyAdminLink ? false : invitation.maxUses === null,
        maxUses: isLegacyAdminLink ? "1" : String(invitation.maxUses ?? Math.max(invitation.useCount, 1)),
        neverExpires: invitation.expiresAt === null,
        expiresAt: isoToLocalDateTime(invitation.expiresAt),
      })
      setValidationError(null)
      mutation.reset()
    }
  }, [invitation?.id, open])

  if (!invitation || !settings) return null

  const submit = () => {
    const original = openedInvitationRef.current
    if (!original) return
    const patch = buildInviteLinkPatch(original, settings)
    if (Object.keys(patch).length === 0) {
      onOpenChange(false)
      return
    }
    const error = validateInviteLinkSettings(settings, invitation.useCount)
    setValidationError(error)
    if (error) return
    const generation = generationRef.current
    mutation.mutate(
      { invitationId: original.id, patch },
      {
        onSuccess: () => {
          if (generation !== generationRef.current) return
          onSuccess()
          onOpenChange(false)
        },
      }
    )
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} disableSnapPoints>
      <ResponsiveDialogContent desktopClassName="max-w-md" drawerClassName="max-h-[92dvh] overflow-y-auto">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Edit invite link</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <div className="space-y-5 px-4 sm:px-6">
          <InviteLinkSettingsFields value={settings} onChange={setSettings} role={invitation.role} />
          {(validationError || mutation.error) && (
            <p role="alert" className="text-sm text-destructive">
              {validationError ?? (mutation.error instanceof Error ? mutation.error.message : "Failed to update link.")}
            </p>
          )}
          <ResponsiveDialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={mutation.isPending}>
              {mutation.isPending ? "Saving..." : "Save changes"}
            </Button>
          </ResponsiveDialogFooter>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
