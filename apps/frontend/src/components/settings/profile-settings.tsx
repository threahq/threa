import { useState, type ComponentProps, type KeyboardEvent } from "react"
import { useParams } from "react-router-dom"
import { Smile } from "lucide-react"
import { resolveActiveStatus } from "@threahq/types"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAuth } from "@/auth"
import { useUpdateProfile } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { StatusPicker } from "@/components/status/status-picker"
import { formatStatusClearLabel } from "@/lib/status"
import { cn } from "@/lib/utils"
import { AvatarSection } from "./avatar-section"
import { useCommittedText } from "./committed-field"
import {
  FieldAddon,
  SETTING_CONTROL_CLASS,
  SETTING_CONTROL_HEIGHT,
  SETTING_CONTROL_WIDTH,
  SettingRow,
  SettingValue,
  SettingsSection,
  settingIds,
  useSettingDescribedBy,
  SaveError,
  SaveIndicator,
} from "./setting-primitives"
import { settingDef, type SettingId } from "./settings-registry"
import { SETTING_NOTE_TEXT } from "./setting-text"
import { toast } from "sonner"

const PRONOUN_PRESETS = ["he/him", "she/her", "they/them", "xe/xem"] as const
const DESCRIPTION_MAX = 500

function useCurrentUser(workspaceId: string): ReturnType<typeof useWorkspaceUsers>[number] | null {
  const { user } = useAuth()
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  if (!user) return null
  return workspaceUsers.find((u) => u.workosUserId === user.id) ?? null
}

type Commit = (value: string | null) => Promise<unknown>

/** Profile fields store a cleared value as null. */
function committedProfileText(saved: string, commit: Commit, required = false) {
  return {
    saved,
    required,
    commit: (value: string) => commit(value || null),
    failureMessage: (error: unknown) => (error instanceof Error && error.message) || "Couldn't save your profile",
  }
}

function enterSaves(save: () => Promise<void>) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    void save()
  }
}

interface TextSettingProps {
  setting: SettingId
  saved: string
  commit: Commit
  required?: boolean
  prefix?: string
  inputProps?: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur" | "onKeyDown" | "id">
}

function TextSetting({ setting, saved, commit, required, prefix, inputProps }: TextSettingProps) {
  const ids = settingIds(setting)
  const field = useCommittedText<HTMLInputElement>(committedProfileText(saved, commit, required))
  const errorId = `${ids.control}-error`
  return (
    <SettingRow
      setting={setting}
      control={
        <div className={cn("flex items-stretch", SETTING_CONTROL_WIDTH)}>
          {prefix && (
            <FieldAddon side="start" aria-hidden>
              {prefix}
            </FieldAddon>
          )}
          <div className="relative min-w-0 flex-1">
            <Input
              {...inputProps}
              ref={field.fieldRef}
              id={ids.control}
              value={field.value}
              required={required}
              aria-invalid={field.state.kind === "error"}
              aria-errormessage={field.state.kind === "error" ? errorId : undefined}
              onChange={(event) => field.onChange(event.target.value)}
              onBlur={() => void field.save()}
              onKeyDown={enterSaves(field.save)}
              className={cn("w-full pr-9", SETTING_CONTROL_HEIGHT, prefix && "rounded-l-none")}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              <SaveIndicator state={field.state} />
            </span>
          </div>
        </div>
      }
    >
      {field.state.kind === "error" && <SaveError id={errorId} state={field.state} />}
    </SettingRow>
  )
}

function StatusSetting({
  workspaceId,
  user,
}: {
  workspaceId: string
  user: NonNullable<ReturnType<typeof useCurrentUser>>
}) {
  const [open, setOpen] = useState(false)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const ids = settingIds("status")
  const activeStatus = resolveActiveStatus({
    statusEmoji: user.statusEmoji ?? null,
    statusText: user.statusText ?? null,
    statusExpiresAt: user.statusExpiresAt ?? null,
  })
  const glyph = activeStatus?.emoji ? toEmoji(activeStatus.emoji) : null
  const clearLabel = formatStatusClearLabel(activeStatus?.expiresAt ?? null)

  return (
    <SettingRow
      setting="status"
      labelFor={false}
      description={
        <>
          {settingDef("status").description}
          {clearLabel && <span className="mt-0.5 block">{clearLabel}</span>}
        </>
      }
      control={
        <>
          <Button
            id={ids.control}
            type="button"
            variant="outline"
            aria-labelledby={`${ids.label} ${ids.control}`}
            aria-describedby={ids.description}
            className={cn("justify-start gap-2 font-normal", SETTING_CONTROL_CLASS)}
            onClick={() => setOpen(true)}
          >
            {glyph ? (
              <span className="text-base leading-none">{glyph}</span>
            ) : (
              <Smile aria-hidden className="h-4 w-4 text-muted-foreground" />
            )}
            <span className={cn("truncate", !activeStatus && "text-muted-foreground")}>
              {activeStatus?.text || (glyph ? "" : "Set a status")}
            </span>
          </Button>
          {open && <StatusPicker workspaceId={workspaceId} open onOpenChange={setOpen} />}
        </>
      }
    />
  )
}

function PronounsSetting({ saved, commit }: { saved: string; commit: (value: string | null) => Promise<unknown> }) {
  const ids = settingIds("pronouns")
  const customErrorId = `${ids.control}-custom-error`
  const isPreset = (PRONOUN_PRESETS as readonly string[]).includes(saved)
  const [customOpen, setCustomOpen] = useState(false)
  const custom = useCommittedText<HTMLInputElement>(
    committedProfileText(isPreset ? "" : saved, async (value) => {
      await commit(value)
      setCustomOpen(false)
    })
  )
  const showCustom = customOpen || (saved !== "" && !isPreset)
  const selectValue = showCustom ? "custom" : saved || "none"

  const choose = async (value: string) => {
    if (value === "custom") {
      setCustomOpen(true)
      return
    }
    setCustomOpen(false)
    const next = value === "none" ? null : value
    if ((next ?? "") === saved) return
    try {
      await commit(next)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save your pronouns")
    }
  }

  return (
    <SettingRow
      setting="pronouns"
      labelFor={false}
      control={
        <div className={cn("flex items-center gap-2", SETTING_CONTROL_WIDTH)}>
          <Select value={selectValue} onValueChange={(value) => void choose(value)}>
            <SelectTrigger
              id={ids.control}
              aria-labelledby={ids.label}
              className={cn(SETTING_CONTROL_HEIGHT, showCustom ? "w-28 shrink-0" : "min-w-0 flex-1")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {PRONOUN_PRESETS.map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {preset}
                </SelectItem>
              ))}
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
          {showCustom && (
            <div className="relative min-w-0 flex-1">
              <Input
                ref={custom.fieldRef}
                aria-label="Custom pronouns"
                aria-invalid={custom.state.kind === "error"}
                aria-errormessage={custom.state.kind === "error" ? customErrorId : undefined}
                value={custom.value}
                onChange={(event) => custom.onChange(event.target.value)}
                onBlur={() => void custom.save()}
                onKeyDown={enterSaves(custom.save)}
                maxLength={50}
                placeholder="ze/zir"
                className={cn("w-full pr-9", SETTING_CONTROL_HEIGHT)}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                <SaveIndicator state={custom.state} />
              </span>
            </div>
          )}
        </div>
      }
    >
      {custom.state.kind === "error" && <SaveError id={customErrorId} state={custom.state} />}
    </SettingRow>
  )
}

function DescriptionSetting({ saved, commit }: { saved: string; commit: (value: string | null) => Promise<unknown> }) {
  const ids = settingIds("bio")
  const field = useCommittedText<HTMLTextAreaElement>(committedProfileText(saved, commit))
  const counterId = `${ids.control}-count`
  const errorId = `${ids.control}-error`
  const describedBy = useSettingDescribedBy("bio", { extra: [counterId] })
  return (
    <SettingRow setting="bio" stacked>
      <Textarea
        ref={field.fieldRef}
        id={ids.control}
        aria-invalid={field.state.kind === "error"}
        aria-errormessage={field.state.kind === "error" ? errorId : undefined}
        value={field.value}
        onChange={(event) => field.onChange(event.target.value)}
        onBlur={() => void field.save()}
        maxLength={DESCRIPTION_MAX}
        rows={3}
        placeholder="What you do, in a line or two"
        aria-describedby={describedBy}
        className="resize-none"
      />
      <div className="mt-1 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <SaveError id={errorId} state={field.state} />
        </div>
        <SaveIndicator state={field.state} />
        <p id={counterId} className={cn("tabular-nums text-muted-foreground", SETTING_NOTE_TEXT)}>
          {field.value.length}/{DESCRIPTION_MAX}
        </p>
      </div>
    </SettingRow>
  )
}

export function ProfileSettings() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const currentUser = useCurrentUser(workspaceId!)
  const updateProfile = useUpdateProfile(workspaceId!)

  if (!currentUser) return null

  const save = updateProfile.mutateAsync

  return (
    <div className="space-y-8">
      <SettingsSection section="identity">
        <SettingRow
          setting="avatar"
          labelFor={false}
          control={
            <AvatarSection workspaceId={workspaceId!} userName={currentUser.name} avatarUrl={currentUser.avatarUrl} />
          }
        />
        <TextSetting
          setting="display-name"
          saved={currentUser.name}
          commit={(name) => save({ name: name ?? "" })}
          required
          inputProps={{ maxLength: 100, autoComplete: "name" }}
        />
        <StatusSetting workspaceId={workspaceId!} user={currentUser} />
        <PronounsSetting saved={currentUser.pronouns ?? ""} commit={(pronouns) => save({ pronouns })} />
        <DescriptionSetting saved={currentUser.description ?? ""} commit={(description) => save({ description })} />
      </SettingsSection>

      <SettingsSection section="contact">
        <SettingRow
          setting="email"
          labelFor={false}
          control={
            <SettingValue id={settingIds("email").control} className={SETTING_CONTROL_WIDTH}>
              {currentUser.email}
            </SettingValue>
          }
        />
        <TextSetting
          setting="phone"
          saved={currentUser.phone ?? ""}
          commit={(phone) => save({ phone })}
          inputProps={{ maxLength: 30, type: "tel", autoComplete: "tel", placeholder: "+1 555-0123" }}
        />
        <TextSetting
          setting="github"
          saved={currentUser.githubUsername ?? ""}
          commit={(githubUsername) => save({ githubUsername })}
          prefix="github.com/"
          inputProps={{ maxLength: 39, placeholder: "username", autoCapitalize: "none", spellCheck: false }}
        />
      </SettingsSection>
    </div>
  )
}
