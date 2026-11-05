import { useId } from "react"
import { toast } from "sonner"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { SwitchSetting, settingIds } from "@/components/settings/setting-primitives"
import { SettingCheckboxList, type SettingCheckboxBleed } from "@/components/settings/setting-lists"
import { SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"
import { settingDef } from "@/components/settings/settings-registry"
import { useUpdateToolPolicy } from "@/hooks/use-streams"
import { TOOL_PRIVACY_CATEGORY_LABELS, type ToolPrivacyCategory, type ToolPrivacyPolicy } from "@threahq/types"

// `messaging` is intentionally excluded: the agent's own reply tool is always
// allowed, so it is never offered as a toggle. The description is keyed by a
// `Record` over every *other* category, so adding a new `ToolPrivacyCategory` is a
// compile error here until it's given picker copy (or excluded) — the picker can
// never silently drop a category the backend reports as configured. Labels come
// from the shared `TOOL_PRIVACY_CATEGORY_LABELS` (INV-33).
type GateableCategory = Exclude<ToolPrivacyCategory, "messaging">

const CATEGORY_META: Record<GateableCategory, { description: string }> = {
  web: { description: "Web search, fetching public URLs, and internet in the sandbox." },
  workspace: { description: "Search this workspace's messages, streams, and memos, and run commands in a sandbox." },
  github: { description: "Read from connected GitHub." },
  linear: { description: "Read from connected Linear." },
}

const CATEGORY_OPTIONS: { value: GateableCategory; label: string; description: string }[] = (
  Object.keys(CATEGORY_META) as GateableCategory[]
).map((value) => ({ value, label: TOOL_PRIVACY_CATEGORY_LABELS[value], ...CATEGORY_META[value] }))

const ALL_GATEABLE: ToolPrivacyCategory[] = CATEGORY_OPTIONS.map((option) => option.value)

// Inside the enclave Ariadne only builds web tools, so on an encrypted
// scratchpad the other categories exist as toggles but aren't wired yet.
const ENCLAVE_TOOL_CATEGORIES = new Set<ToolPrivacyCategory>(["web"])
const NOT_IN_ENCLAVE_REASON = "Not available in encrypted scratchpads yet. Ariadne only has web tools there."

interface ToolPolicyControlProps {
  /** Current policy: `null` = unrestricted; an array (incl. `[]`) = restricted to those categories. */
  value: ToolPrivacyPolicy
  /** Apply a new policy — live mutation in settings, a local draft write at creation. */
  onChange: (next: ToolPrivacyPolicy) => void
  /**
   * Categories the workspace actually has configured (so unconnected GitHub /
   * Linear never show). Undefined falls back to all gateable categories.
   */
  configuredCategories?: ToolPrivacyCategory[]
  /** Encrypted scratchpad: non-web categories render disabled, with a reason. */
  e2e: boolean
  /** Disables all inputs while a change is in flight. */
  disabled?: boolean
}

/**
 * Presentational, controlled tool-policy editor. Owns no persistence — the
 * caller maps `onChange` to a live mutation (settings) or a draft write
 * (at-creation). `value` is the single source of truth, so there is no local
 * state to drift.
 */
export function ToolPolicyControl({ value, onChange, configuredCategories, e2e, disabled }: ToolPolicyControlProps) {
  const def = settingDef("stream-tools")
  const switchId = useId()
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <Label
          htmlFor={switchId}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center gap-1 font-normal sm:min-h-0 [@media(pointer:coarse)]:min-h-11"
        >
          <span id={`${switchId}-label`} className="text-sm font-medium leading-snug">
            {def.label}
          </span>
          <span id={`${switchId}-description`} className={SETTING_MUTED_NOTE_TEXT}>
            {def.description}
          </span>
        </Label>
        <Switch
          id={switchId}
          checked={value !== null}
          onCheckedChange={(on) => onChange(on ? [] : null)}
          disabled={disabled}
          aria-labelledby={`${switchId}-label`}
          aria-describedby={`${switchId}-description`}
        />
      </div>
      <ToolCategories
        value={value}
        onChange={onChange}
        configuredCategories={configuredCategories}
        e2e={e2e}
        disabled={disabled}
        labelledBy={`${switchId}-label`}
        bleed="inset"
      />
    </div>
  )
}

/** The tool groups a restricted policy allows; nothing while unrestricted. */
function ToolCategories({
  value,
  onChange,
  configuredCategories,
  e2e,
  disabled,
  labelledBy,
  bleed,
}: ToolPolicyControlProps & { labelledBy: string; bleed: SettingCheckboxBleed }) {
  const emptyId = useId()
  if (value === null) return null
  const allowed = new Set(value)
  // Show the configured categories *plus* anything already granted — a category
  // can be stored (e.g. GitHub) and later un-configured (the integration is
  // disconnected). Dropping it from the picker would strand the grant on,
  // invisible and unrevokable; the union keeps it editable so the owner can turn
  // it off. (The stored grant is already inert — no tools are built for it — so
  // this is display-only, not an enforcement change.)
  const shown = new Set<ToolPrivacyCategory>([...(configuredCategories ?? ALL_GATEABLE), ...allowed])
  const items = CATEGORY_OPTIONS.filter((option) => shown.has(option.value)).map((option) => ({
    ...option,
    reason: e2e && !ENCLAVE_TOOL_CATEGORIES.has(option.value) ? NOT_IN_ENCLAVE_REASON : undefined,
  }))

  return (
    <div className="space-y-2">
      <SettingCheckboxList
        items={items}
        bleed={bleed}
        selected={allowed}
        disabled={disabled}
        onCheckedChange={(category, checked) => {
          const next = new Set(allowed)
          if (checked) next.add(category)
          else next.delete(category)
          onChange([...next])
        }}
        aria-labelledby={labelledBy}
        aria-describedby={allowed.size === 0 ? emptyId : undefined}
      />
      {allowed.size === 0 && (
        <p id={emptyId} className={SETTING_MUTED_NOTE_TEXT}>
          No tool groups picked. The agent can only read and reply.
        </p>
      )}
    </div>
  )
}

interface ToolPolicyPickerProps {
  workspaceId: string
  streamId: string
  /** Current policy: `null` = unrestricted; an array (incl. `[]`) = restricted to those categories. */
  value: ToolPrivacyPolicy
  configuredCategories?: ToolPrivacyCategory[]
  e2e: boolean
}

/** The settings-window row, bound to the live `useUpdateToolPolicy` mutation. */
export function ToolPolicyPicker({ workspaceId, streamId, value, configuredCategories, e2e }: ToolPolicyPickerProps) {
  const { mutateAsync, isPending } = useUpdateToolPolicy(workspaceId, streamId)

  const handleChange = async (next: ToolPrivacyPolicy) => {
    try {
      await mutateAsync(next)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update tool access")
    }
  }

  return (
    <SwitchSetting
      setting="stream-tools"
      checked={value !== null}
      onCheckedChange={(on) => void handleChange(on ? [] : null)}
      disabled={isPending}
    >
      <ToolCategories
        value={value}
        onChange={(next) => void handleChange(next)}
        configuredCategories={configuredCategories}
        e2e={e2e}
        disabled={isPending}
        labelledBy={settingIds("stream-tools").label}
        bleed="card"
      />
    </SwitchSetting>
  )
}
