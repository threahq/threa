import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { roleDisplayName, WORKSPACE_ROLE_SLUGS, type WorkspaceRoleSlug } from "@threa/types"

export interface InviteLinkSettingsValue {
  unlimited: boolean
  maxUses: string
  neverExpires: boolean
  expiresAt: string
}

export function isoToLocalDateTime(value: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export function localDateTimeToIso(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function defaultInviteExpiry(): string {
  return isoToLocalDateTime(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString())
}

export function validateInviteLinkSettings(value: InviteLinkSettingsValue, minimumUses = 0): string | null {
  if (!value.unlimited) {
    const maxUses = Number(value.maxUses)
    if (!Number.isInteger(maxUses) || maxUses <= 0) return "Maximum joins must be a positive whole number."
    if (maxUses < minimumUses) return `Maximum joins cannot be lower than ${minimumUses}.`
  }
  if (!value.neverExpires) {
    const expiresAt = localDateTimeToIso(value.expiresAt)
    if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return "Expiration must be in the future."
  }
  return null
}

export function InviteLinkSettingsFields({
  value,
  onChange,
  role = WORKSPACE_ROLE_SLUGS.MEMBER,
}: {
  value: InviteLinkSettingsValue
  onChange: (value: InviteLinkSettingsValue) => void
  role?: WorkspaceRoleSlug
}) {
  const fixedSingleUse = role === WORKSPACE_ROLE_SLUGS.ADMIN

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="invite-max-uses">Maximum joins</Label>
          {!fixedSingleUse && (
            <div className="flex items-center gap-2">
              <Label htmlFor="invite-unlimited" className="text-xs font-normal text-muted-foreground">
                Unlimited
              </Label>
              <Switch
                id="invite-unlimited"
                checked={value.unlimited}
                onCheckedChange={(unlimited) => onChange({ ...value, unlimited })}
              />
            </div>
          )}
        </div>
        {fixedSingleUse ? (
          <Input id="invite-max-uses" type="number" value={1} disabled />
        ) : (
          !value.unlimited && (
            <Input
              id="invite-max-uses"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={value.maxUses}
              onChange={(event) => onChange({ ...value, maxUses: event.target.value })}
            />
          )
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="invite-expires-at">Expiration</Label>
          <div className="flex items-center gap-2">
            <Label htmlFor="invite-never-expires" className="text-xs font-normal text-muted-foreground">
              Never expires
            </Label>
            <Switch
              id="invite-never-expires"
              checked={value.neverExpires}
              onCheckedChange={(neverExpires) => onChange({ ...value, neverExpires })}
            />
          </div>
        </div>
        {!value.neverExpires && (
          <Input
            id="invite-expires-at"
            type="datetime-local"
            value={value.expiresAt}
            onChange={(event) => onChange({ ...value, expiresAt: event.target.value })}
          />
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Anyone with this link can join the workspace as {roleDisplayName(role).toLowerCase()}.
      </p>
    </div>
  )
}
